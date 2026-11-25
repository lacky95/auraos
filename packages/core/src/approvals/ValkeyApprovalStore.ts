/**
 * `ApprovalStore` on Valkey (5.10, D17).
 *
 *   approval:<id>                  the record (JSON), kept APPROVAL_KEEP_MS past expiresAt
 *                                  so a polling requester still reads `expired`
 *   approval:slot:<requester>      the requester's one pending id, until expiresAt
 *   approval:pending               pending ids by creation time, for the dialog queue
 *   approval:blocked               appId → {at, by}: "Deny and block requests from this app"
 *   ratelimit:approval:<r>:<min>   creates per requester per minute
 *
 * Every change is a compare-and-set of the raw record (one Lua call) after
 * `transitionApproval()` decided it, so of two concurrent consumers exactly
 * one wins and the other re-reads a `consumed` record. Creating checks and
 * takes the requester's slot in the same script.
 *
 * Nothing here holds a credential: the record has the requester, the payload
 * hash and the server-built display only.
 */
import { createHash } from 'node:crypto';
import type { Redis } from '@aura/kv-store';
import {
  effectiveApprovalState, isApprovalId, newApprovalId, newApprovalRecord, requesterKey,
  transitionApproval, type ApprovalEvent,
} from './state.js';
import {
  MAX_PENDING_PER_REQUESTER,
  type ApprovalClaim, type ApprovalDecider, type ApprovalRecord, type ApprovalRequest,
  type ApprovalRequester, type ApprovalResult, type ApprovalStore,
} from './types.js';

const RECORD_PREFIX = 'approval:';
const SLOT_PREFIX = 'approval:slot:';
export const APPROVAL_PENDING_KEY = 'approval:pending';
export const APPROVAL_BLOCKED_KEY = 'approval:blocked';
/** How long a decided or expired record stays readable. */
export const APPROVAL_KEEP_MS = 10 * 60 * 1000;
/** New requests one requester may create per minute (5.10 "No approval spam"). */
export const APPROVAL_CREATES_PER_MINUTE = 6;
/** Compare-and-set retries before a write gives up as `wrong-state`. */
const CAS_ATTEMPTS = 5;

// The slot can hold MAX_PENDING_PER_REQUESTER ids only when that is 1; a test pins it.
const CREATE = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[4])
redis.call('ZADD', KEYS[3], ARGV[5], ARGV[3])
return 1`;

const SWAP = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
if ARGV[5] == '1' then
  if redis.call('GET', KEYS[2]) == ARGV[4] then redis.call('DEL', KEYS[2]) end
  redis.call('ZREM', KEYS[3], ARGV[4])
end
return 1`;

const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);
const slotKey = (r: ApprovalRequester) => SLOT_PREFIX + digest(requesterKey(r));
const recordKey = (id: string) => RECORD_PREFIX + id;

/** The app a requester speaks for, or null (the owner directly, an API key). */
export function requesterAppId(r: ApprovalRequester): string | null {
  if (r.kind === 'instance') return r.appId;
  if (r.kind === 'user') return r.through?.appId ?? null;
  return null;
}

export interface ApprovalBlock { appId: string; at: number; by: string }

export interface ValkeyApprovalStoreOptions {
  redis: () => Redis;
  now?: () => number;
}

function parse(raw: string | null): ApprovalRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as ApprovalRecord;
    return r && isApprovalId(r.id) ? r : null;
  } catch {
    return null;
  }
}

export class ValkeyApprovalStore implements ApprovalStore {
  private readonly redis: () => Redis;
  private readonly now: () => number;

  constructor(opts: ValkeyApprovalStoreOptions) {
    this.redis = opts.redis;
    this.now = opts.now ?? Date.now;
  }

  /**
   * A new pending record. A requester holds one pending request at a time:
   * the same request again (action and payload hash) answers with the one it
   * already holds, anything else is `too-many-pending` until that one is
   * decided or expires. Blocked apps and requesters over the rate limit are
   * refused first.
   */
  async create(request: ApprovalRequest): Promise<ApprovalResult> {
    const appId = requesterAppId(request.requester);
    if (appId && await this.isBlocked(appId)) return { ok: false, reason: 'blocked' };

    const slot = slotKey(request.requester);
    const held = await this.heldBy(slot);
    if (held) {
      return held.action === request.action && held.payloadHash === request.payloadHash
        ? { ok: true, record: held }
        : { ok: false, reason: 'too-many-pending' };
    }
    if (await this.overLimit(slot)) return { ok: false, reason: 'rate-limited' };

    const now = this.now();
    const record = newApprovalRecord(request, newApprovalId(), now);
    const won = await this.redis().eval(
      CREATE, 3, recordKey(record.id), slot, APPROVAL_PENDING_KEY,
      JSON.stringify(record), String(record.expiresAt - now + APPROVAL_KEEP_MS), record.id,
      String(record.expiresAt - now), String(now),
    );
    return won === 1 ? { ok: true, record } : { ok: false, reason: 'too-many-pending' };
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    if (!isApprovalId(id)) return null;
    const record = parse(await this.redis().get(recordKey(id)));
    return record ? { ...record, state: effectiveApprovalState(record, this.now()) } : null;
  }

  async listPending(): Promise<ApprovalRecord[]> {
    const r = this.redis();
    const ids = await r.zrange(APPROVAL_PENDING_KEY, 0, -1);
    const out: ApprovalRecord[] = [];
    for (const id of ids) {
      const record = await this.get(id);
      if (record?.state === 'pending') out.push(record);
      // Expired: marked, which also frees its slot. Anything else just leaves the queue.
      else if (record?.state === 'expired') await this.apply(id, { type: 'expire' });
      else await r.zrem(APPROVAL_PENDING_KEY, id);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  approve(id: string, by: ApprovalDecider): Promise<ApprovalResult> {
    return this.apply(id, { type: 'approve', by });
  }

  deny(id: string, by: ApprovalDecider): Promise<ApprovalResult> {
    return this.apply(id, { type: 'deny', by });
  }

  consume(id: string, claim: ApprovalClaim): Promise<ApprovalResult> {
    return this.apply(id, { type: 'consume', claim });
  }

  // ── blocked apps ──────────────────────────────────────────────────────────

  async isBlocked(appId: string): Promise<boolean> {
    return (await this.redis().hexists(APPROVAL_BLOCKED_KEY, appId)) === 1;
  }

  /** "Deny and block requests from this app". `by` is an audit label, never a credential. */
  async block(appId: string, by: string): Promise<void> {
    await this.redis().hset(APPROVAL_BLOCKED_KEY, appId, JSON.stringify({ at: this.now(), by }));
  }

  /** Whether a block was lifted. */
  async unblock(appId: string): Promise<boolean> {
    return (await this.redis().hdel(APPROVAL_BLOCKED_KEY, appId)) === 1;
  }

  async listBlocked(): Promise<ApprovalBlock[]> {
    const all = await this.redis().hgetall(APPROVAL_BLOCKED_KEY);
    return Object.entries(all).map(([appId, raw]) => {
      try {
        const v = JSON.parse(raw) as { at?: unknown; by?: unknown };
        return { appId, at: typeof v.at === 'number' ? v.at : 0, by: typeof v.by === 'string' ? v.by : '' };
      } catch {
        return { appId, at: 0, by: '' };
      }
    }).sort((a, b) => a.appId.localeCompare(b.appId));
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** The pending record a requester's slot points at, or null. */
  private async heldBy(slot: string): Promise<ApprovalRecord | null> {
    const id = await this.redis().get(slot);
    const record = id ? await this.get(id) : null;
    return record?.state === 'pending' ? record : null;
  }

  private async overLimit(slot: string): Promise<boolean> {
    const r = this.redis();
    const bucket = `ratelimit:${slot}:${Math.floor(this.now() / 60_000)}`;
    const n = await r.incr(bucket);
    if (n === 1) await r.pexpire(bucket, 120_000);
    return n > APPROVAL_CREATES_PER_MINUTE;
  }

  /** Re-read, transition, compare-and-set; again on a concurrent change. */
  private async apply(id: string, event: ApprovalEvent): Promise<ApprovalResult> {
    if (!isApprovalId(id)) return { ok: false, reason: 'not-found' };
    const r = this.redis();
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const raw = await r.get(recordKey(id));
      const record = parse(raw);
      if (!raw || !record) return { ok: false, reason: 'not-found' };
      const now = this.now();
      const t = transitionApproval(record, event, now);
      if (!t.ok) {
        // A pending record found expired is marked, so its slot frees at once.
        if (t.reason === 'expired' && record.state === 'pending') await this.apply(id, { type: 'expire' });
        return t;
      }
      const leavesPending = record.state === 'pending' ? '1' : '0';
      const ttl = Math.max(1, record.expiresAt - now + APPROVAL_KEEP_MS);
      const swapped = await r.eval(
        SWAP, 3, recordKey(id), slotKey(record.requester), APPROVAL_PENDING_KEY,
        raw, JSON.stringify(t.record), String(ttl), id, leavesPending,
      );
      if (swapped === 1) return { ok: true, record: t.record };
    }
    return { ok: false, reason: 'wrong-state' };
  }
}

// A slot is a single id: raising the limit needs a set here.
const oneSlot: 1 = MAX_PENDING_PER_REQUESTER;
void oneSlot;
