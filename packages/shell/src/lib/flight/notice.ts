/**
 * Flight notices — what the perched tab shows when the app asks for attention
 * (`POST /api/activities/<id>/flight/notify`, core `FlightNotice`). Pure, so
 * test/flight-notice.test.ts can drive it; layer.ts paints the result.
 */
export type NoticeLevel = 'info' | 'attention' | 'urgent';
export interface Notice {
  level: NoticeLevel;
  text?: string;
  count?: number;
  blink?: number;
  ttlMs?: number;
  clearOnOpen?: boolean;
  /** Stamped by the OS on every notify. */
  at?: number;
}

export const NOTICE_TTL_DEFAULT = 6_000;
export const NOTICE_BLINK_DEFAULT = 3;

export interface NoticeView {
  /** Level to colour the tab / panel with; null = plain badge look. */
  level: NoticeLevel | null;
  /** The count bubble: the notice's count, else the badge's. */
  count: number | null;
  text: string | null;
  /** The text bubble is still within its ttl. */
  showText: boolean;
  /** One-shot flashes to play now (0 = none). */
  blinkTimes: number;
  /** When the text bubble should go (ms timestamp), or null. */
  textUntil: number | null;
}

/**
 * `prevAt`: the notice `at` painted last time — null on a flight's FIRST paint
 * (fresh build, page load, restored session), so nothing blinks then; a
 * later notice with a different `at` does.
 */
export function noticeView(notice: Notice | null | undefined, badgeCount: number | undefined, prevAt: number | null, now: number): NoticeView {
  const fallback = badgeCount && badgeCount > 0 ? badgeCount : null;
  if (!notice || !notice.level) return { level: null, count: fallback, text: null, showText: false, blinkTimes: 0, textUntil: null };
  const at = notice.at ?? 0;
  const fresh = prevAt !== null && at !== prevAt;
  const until = at > 0 ? at + (notice.ttlMs ?? NOTICE_TTL_DEFAULT) : 0;
  const text = typeof notice.text === 'string' && notice.text.trim() ? notice.text.trim() : null;
  const showText = !!text && now < until;
  return {
    level: notice.level,
    count: notice.count && notice.count > 0 ? notice.count : fallback,
    text,
    showText,
    blinkTimes: fresh ? (notice.blink ?? NOTICE_BLINK_DEFAULT) : 0,
    textUntil: showText ? until : null,
  };
}
