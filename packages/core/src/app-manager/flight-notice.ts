/**
 * Flight notices — validation of what an app may put on a flight's tab to ask
 * for attention (`AppManager.notifyFlight`). Every input comes from an app.
 */
import type { FlightNotice, FlightNoticeLevel, FlightPatch } from '../types/activity.js';

export const NOTICE_TEXT_MAX = 24;
export const NOTICE_COUNT_MAX = 9999;
export const NOTICE_BLINK_DEFAULT = 3;
export const NOTICE_BLINK_MAX = 10;
export const NOTICE_TTL_DEFAULT_MS = 6_000;
export const NOTICE_TTL_MIN_MS = 1_000;
export const NOTICE_TTL_MAX_MS = 60_000;
const LEVELS: ReadonlySet<string> = new Set<FlightNoticeLevel>(['info', 'attention', 'urgent']);

/** A valid notice (clamped), stamped `at`. Throws on a missing/unknown level. */
export function cleanNotice(n: FlightNotice, at: number): FlightNotice {
  if (!n || typeof n !== 'object' || !LEVELS.has(String((n as FlightNotice).level))) throw new Error('flight: notice.level must be info|attention|urgent');
  const out: FlightNotice = { level: n.level, at };
  if (typeof n.text === 'string' && n.text.trim()) out.text = n.text.trim().slice(0, NOTICE_TEXT_MAX);
  if (typeof n.count === 'number' && Number.isFinite(n.count) && n.count > 0) out.count = Math.min(NOTICE_COUNT_MAX, Math.round(n.count));
  if (typeof n.blink === 'number' && Number.isFinite(n.blink)) out.blink = Math.min(NOTICE_BLINK_MAX, Math.max(0, Math.round(n.blink)));
  if (typeof n.ttlMs === 'number' && Number.isFinite(n.ttlMs)) out.ttlMs = Math.min(NOTICE_TTL_MAX_MS, Math.max(NOTICE_TTL_MIN_MS, Math.round(n.ttlMs)));
  if (n.clearOnOpen === false) out.clearOnOpen = false;
  return out;
}

/** Does this patch open the flight (unfold it from its tab)? Such an open acknowledges a notice. */
export function patchOpensFlight(patch: FlightPatch): boolean {
  return patch.perch === null || patch.folded === false;
}

/** Whether `notice` goes away when the flight is opened. */
export function noticeClearsOnOpen(notice: FlightNotice | undefined): boolean {
  return !!notice && notice.clearOnOpen !== false;
}
