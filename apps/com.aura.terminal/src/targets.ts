/**
 * Voice-friendly session addressing for the terminal MCP — pure, no I/O.
 *
 * A session's canonical id is `<instanceId>#a<n>` (`com.aura.terminal-16#a1`),
 * but agents relay what people SAY: "16A1", "14 a3", "terminal 16 a1", "a1".
 * And agent frameworks mask tool arguments whose name looks secret — OpenClaw
 * turns every `session` argument into `***` in the transcript, so the model
 * re-sends `***`. This module turns all of that into one canonical id, or into
 * a structured error that lists the live candidates.
 *
 * Resolution order (B1/B2/B3 in terminal-improvements.md):
 *   1. a canonical id → itself (no listing needed; the caller fast-paths it);
 *   2. a spoken alias → the unique match; several → the single one in use;
 *   3. nothing / a masked placeholder → the default target: the session this
 *      process touched last → the single session a human has open → the only
 *      session there is → error with candidates.
 *
 * Node builtins only: the tests import this file under --experimental-strip-types.
 */

export const TERMINAL_APP_ID = 'com.aura.terminal';

export interface Candidate {
  id: string;
  inUse: boolean;
  /** Foreground command (`bash`, `claude`, …) when known. */
  command?: string | null;
}

export interface Resolved {
  /** Canonical session id. */
  id: string;
  /** What the caller passed, when it was not already the canonical id. */
  resolved_from: string | null;
  /** How it was chosen. */
  how: 'exact' | 'alias' | 'default:last' | 'default:in-use' | 'default:only';
}

export class TargetError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly candidates: string[];
  constructor(code: string, message: string, hint: string, candidates: string[] = []) {
    super(message);
    this.name = 'TargetError';
    this.code = code;
    this.hint = hint;
    this.candidates = candidates;
  }
}

/** `***`, `[redacted]` and friends: a placeholder an agent copied from its own masked history. */
export function isMaskedTarget(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  const s = String(v).trim();
  return s === '' || /^(\*+|\[\s*redacted\s*\]|<\s*redacted\s*>|redacted|xxx+)$/i.test(s);
}

const CANONICAL = /^(com\.aura\.terminal(?:-\d+)?)#([^#\s]+)$/i;

/** The canonical id when `v` already is one (case-normalised), else null. */
export function canonicalId(v: string): string | null {
  const m = CANONICAL.exec(v.trim());
  return m ? `${m[1]!.toLowerCase()}#${m[2]!.toLowerCase()}` : null;
}

/** `com.aura.terminal-16#a1` → `16a1`; the base instance `com.aura.terminal#a1` → `a1`. */
export function aliasOf(id: string): string {
  const m = /^com\.aura\.terminal(?:-(\d+))?#(.+)$/.exec(id);
  return m ? `${m[1] ?? ''}${m[2]}` : id;
}

/**
 * A spoken / typed reference → `{ instance, label }` (either may be null), or
 * null when it does not look like a terminal reference at all.
 * "16A1", "16 a1", "16#a1", "terminal-16 a1", "session a3", "a1", "terminal 16".
 */
export function parseSpoken(v: string): { instance: string | null; label: string | null } | null {
  let s = v.toLowerCase().trim().replace(/^com\.aura\./, '');
  s = s.replace(/\b(terminal|session|instance|tab|window|shell|number|nr|no)\b/g, ' ');
  s = s.replace(/[#\s\-_.:,/]+/g, '');
  const m = /^(\d+)?(?:a(\d+))?$/.exec(s);
  if (!s || !m || (!m[1] && !m[2])) return null;
  return { instance: m[1] ?? null, label: m[2] ? `a${m[2]}` : null };
}

const instanceOf = (id: string) => id.split('#')[0]!;
const labelOf = (id: string) => id.split('#').slice(1).join('#');

/** "16a1 (claude, in use)" — what an error shows so the agent can pick. */
export function describeCandidates(cands: Candidate[], max = 12): string[] {
  return cands.slice(0, max).map((c) =>
    `${aliasOf(c.id)} = ${c.id}${c.command || c.inUse ? ` (${[c.command, c.inUse ? 'in use' : ''].filter(Boolean).join(', ')})` : ''}`);
}

function pickDefault(cands: Candidate[], last: string | null): Resolved | null {
  if (last && cands.some((c) => c.id === last)) return { id: last, resolved_from: null, how: 'default:last' };
  const inUse = cands.filter((c) => c.inUse);
  if (inUse.length === 1) return { id: inUse[0]!.id, resolved_from: null, how: 'default:in-use' };
  if (cands.length === 1) return { id: cands[0]!.id, resolved_from: null, how: 'default:only' };
  return null;
}

/**
 * Resolve `raw` against the live sessions. Throws TargetError (code
 * `no-target` / `unknown-target` / `ambiguous-target`) with candidates.
 */
export function resolveTarget(raw: string | undefined | null, cands: Candidate[], opts: { last?: string | null } = {}): Resolved {
  const last = opts.last ?? null;
  const list = describeCandidates(cands);
  if (isMaskedTarget(raw)) {
    const d = pickDefault(cands, last);
    if (d) return { ...d, resolved_from: raw ? String(raw) : null };
    throw new TargetError('no-target',
      cands.length ? `No target given and no default: ${cands.length} sessions exist.` : 'No target given and no terminal session exists.',
      (raw ? `"${raw}" looks like a masked placeholder — pass the field "target" with an alias like "16a1". ` : 'Pass "target", e.g. "16a1". ')
        + (cands.length ? 'Pick one of the candidates.' : 'Ask the user before opening one (open_session).'),
      list);
  }
  const value = String(raw).trim();
  const canon = canonicalId(value);
  if (canon) return { id: canon, resolved_from: canon === value ? null : value, how: 'exact' };

  const spoken = parseSpoken(value);
  if (!spoken) {
    throw new TargetError('unknown-target',
      `"${value}" is not a session id or alias — expected <instanceId>#a<n> (e.g. ${TERMINAL_APP_ID}-2#a3) or an alias like "2a3".`,
      'Use one of the candidates (alias or full id); list_sessions shows them all.', list);
  }
  const matches = cands.filter((c) => {
    if (spoken.instance !== null && instanceOf(c.id) !== `${TERMINAL_APP_ID}-${spoken.instance}`) return false;
    if (spoken.label !== null && labelOf(c.id) !== spoken.label) return false;
    return true;
  });
  if (matches.length === 1) return { id: matches[0]!.id, resolved_from: value, how: 'alias' };
  if (matches.length > 1) {
    const inUse = matches.filter((c) => c.inUse);
    if (inUse.length === 1) return { id: inUse[0]!.id, resolved_from: value, how: 'alias' };
    if (last && matches.some((c) => c.id === last)) return { id: last, resolved_from: value, how: 'alias' };
    throw new TargetError('ambiguous-target', `"${value}" matches ${matches.length} sessions.`,
      'Pass the alias with the instance number (e.g. "16a1") or the full id.', describeCandidates(matches));
  }
  throw new TargetError('unknown-target',
    `"${value}" is not a session id or a live session (no ${spoken.instance ? `instance ${spoken.instance}` : 'instance'}${spoken.label ? ` with session ${spoken.label}` : ''}).`,
    'Use one of the candidates. Do NOT open a new session or instance unless the user explicitly asked for one.', list);
}
