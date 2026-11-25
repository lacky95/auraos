/**
 * Pure helpers for approvals: the payload hash, ids, and the one
 * state-transition function every `ApprovalStore` applies.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  APPROVAL_TTL_MS, FINAL_APPROVAL_STATES,
  type ApprovalClaim, type ApprovalDecider, type ApprovalRecord, type ApprovalRefusal,
  type ApprovalRequest, type ApprovalRequester, type ApprovalState,
} from './types.js';

// ── payload hash ────────────────────────────────────────────────────────────

/**
 * A stable JSON serialization: object keys sorted (by UTF-16 code unit),
 * no whitespace, `undefined` object members left out as JSON.stringify does.
 * Throws on anything JSON can't carry unchanged: non-finite numbers, bigint,
 * functions, symbols, `undefined` in an array or at the top, objects that are
 * not plain (Date, Map, class instances) and cycles. Two payloads that would
 * parse back equal serialize equal.
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const walk = (v: unknown, path: string): string => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'string': return JSON.stringify(v);
      case 'boolean': return v ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(v)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
        return JSON.stringify(v);
      case 'object': break;
      default: throw new TypeError(`canonicalJson: ${typeof v} at ${path}`);
    }
    const obj = v as object;
    if (seen.has(obj)) throw new TypeError(`canonicalJson: cycle at ${path}`);
    seen.add(obj);
    let out: string;
    if (Array.isArray(obj)) {
      out = `[${obj.map((item, i) => {
        if (item === undefined) throw new TypeError(`canonicalJson: undefined at ${path}[${i}]`);
        return walk(item, `${path}[${i}]`);
      }).join(',')}]`;
    } else {
      const proto = Object.getPrototypeOf(obj);
      if (proto !== Object.prototype && proto !== null) throw new TypeError(`canonicalJson: not a plain object at ${path}`);
      const rec = obj as Record<string, unknown>;
      const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
      out = `{${keys.map((k) => `${JSON.stringify(k)}:${walk(rec[k], `${path}.${k}`)}`).join(',')}}`;
    }
    seen.delete(obj);
    return out;
  };
  if (value === undefined) throw new TypeError('canonicalJson: undefined');
  return walk(value, '$');
}

/** SHA-256 (lowercase hex) of `canonicalJson(payload)`. Throws like it. */
export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

export const PAYLOAD_HASH_RE = /^[0-9a-f]{64}$/;

// ── ids ─────────────────────────────────────────────────────────────────────

export const APPROVAL_ID_PREFIX = 'apr_';
/** `apr_` + 22 base64url characters (128 random bits). */
export const APPROVAL_ID_RE = /^apr_[A-Za-z0-9_-]{22}$/;

export function newApprovalId(): string {
  return APPROVAL_ID_PREFIX + randomBytes(16).toString('base64url');
}

export const isApprovalId = (v: unknown): v is string => typeof v === 'string' && APPROVAL_ID_RE.test(v);

// ── requester identity ──────────────────────────────────────────────────────

/** A stable key for a requester: per-requester limits and the consume check. */
export const requesterKey = (r: ApprovalRequester): string => canonicalJson(r);

export const sameRequester = (a: ApprovalRequester, b: ApprovalRequester): boolean =>
  requesterKey(a) === requesterKey(b);

// ── states ──────────────────────────────────────────────────────────────────

/** A new pending record. The store supplies the id and the clock. */
export function newApprovalRecord(request: ApprovalRequest, id: string, now: number): ApprovalRecord {
  return { id, ...request, state: 'pending', createdAt: now, expiresAt: now + APPROVAL_TTL_MS };
}

/** The state as of `now`: an open record past its deadline reads `expired`. */
export function effectiveApprovalState(record: Pick<ApprovalRecord, 'state' | 'expiresAt'>, now: number): ApprovalState {
  if (FINAL_APPROVAL_STATES.has(record.state)) return record.state;
  return now >= record.expiresAt ? 'expired' : record.state;
}

export type ApprovalEvent =
  | { type: 'approve'; by: ApprovalDecider }
  | { type: 'deny'; by: ApprovalDecider }
  | { type: 'consume'; claim: ApprovalClaim }
  /** Mark an open record that is past its deadline. */
  | { type: 'expire' };

export type ApprovalTransition =
  | { ok: true; record: ApprovalRecord }
  | { ok: false; reason: ApprovalRefusal };

/** Whether `by` satisfies the record's level. An operator is always fresh (D18). */
function satisfiesLevel(record: ApprovalRecord, by: ApprovalDecider): boolean {
  return record.level === 'session' || by.kind === 'operator' || by.fresh;
}

/**
 * The one transition function. Pure: it returns a new record or a refusal,
 * and never changes `record`.
 *
 *   pending  + approve  → approved   (before expiresAt, level satisfied)
 *   pending  + deny     → denied     (before expiresAt)
 *   approved + consume  → consumed   (before expiresAt, claim matches exactly)
 *   pending | approved + expire → expired   (at or after expiresAt)
 *
 * Everything else is refused, including any event on a final state.
 */
export function transitionApproval(record: ApprovalRecord, event: ApprovalEvent, now: number): ApprovalTransition {
  const state = effectiveApprovalState(record, now);

  if (event.type === 'expire') {
    if (FINAL_APPROVAL_STATES.has(record.state) || state !== 'expired') return { ok: false, reason: 'wrong-state' };
    return { ok: true, record: { ...record, state: 'expired' } };
  }

  if (state === 'expired') return { ok: false, reason: 'expired' };

  switch (event.type) {
    case 'approve':
      if (state !== 'pending') return { ok: false, reason: 'wrong-state' };
      if (!satisfiesLevel(record, event.by)) return { ok: false, reason: 'needs-fresh-auth' };
      return { ok: true, record: { ...record, state: 'approved', decidedBy: event.by } };
    case 'deny':
      if (state !== 'pending') return { ok: false, reason: 'wrong-state' };
      return { ok: true, record: { ...record, state: 'denied', decidedBy: event.by } };
    case 'consume': {
      if (state !== 'approved') return { ok: false, reason: 'wrong-state' };
      const c = event.claim;
      if (c.action !== record.action || c.payloadHash !== record.payloadHash || !sameRequester(c.requester, record.requester)) {
        return { ok: false, reason: 'mismatch' };
      }
      return { ok: true, record: { ...record, state: 'consumed' } };
    }
    default:
      return { ok: false, reason: 'wrong-state' };
  }
}
