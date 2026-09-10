/**
 * Fuzzy (subsequence) matching for the interactive pickers.
 *
 * Kept out of prompts.ts on purpose: this is the one piece of that machinery
 * that is pure, so it can be asserted from a script without a TTY. prompts.ts
 * needs raw mode and a real terminal to do anything at all.
 *
 * The ranking is tuned around one compatibility rule: **a substring hit always
 * outranks a scattered subsequence hit**. Everyone's muscle memory is the old
 * `includes` filter, so whatever it used to surface first must still come
 * first; the extra fuzzy matches only ever appear underneath.
 */

/** Callers colour `tag`, so escape bytes would otherwise be searchable text. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Characters after which a match reads as the start of a "word". */
const SEPARATORS = new Set(['.', '-', '_', '/', ':', ' ', '@']);

const BONUS_CONSECUTIVE = 8;
const BONUS_START       = 12;
const BONUS_BOUNDARY    = 6;
const BONUS_SUBSTRING   = 40;
const BONUS_SUBSTR_EDGE = 20;
const PENALTY_PER_GAP   = 1;
const PENALTY_GAP_CAP   = 10;
/** Mild, so a tight match in a short id beats the same match buried in prose. */
const PENALTY_LENGTH    = 0.05;

/**
 * Score `needle` against `haystack`, or `null` when it does not match at all.
 * Higher is better; scores are only comparable against the same needle.
 *
 * An empty needle matches everything with score 0 — callers are expected to
 * skip filtering entirely in that case, but returning a match is the sane
 * answer to "does the empty query match".
 */
export function fuzzyScore(haystack: string, needle: string): number | null {
  if (needle === '') return 0;
  const hay = haystack.toLowerCase();
  const pin = needle.toLowerCase();

  // Greedy left-to-right walk. Greedy is not always the *highest*-scoring
  // alignment, but it is O(n) and picks the earliest match, which is what
  // "I typed a prefix" wants.
  let score = 0;
  let prevIdx = -1;
  let from = 0;
  for (const ch of pin) {
    const idx = hay.indexOf(ch, from);
    if (idx === -1) return null;

    if (idx === prevIdx + 1 && prevIdx !== -1) score += BONUS_CONSECUTIVE;
    if (idx === 0) score += BONUS_START;
    else if (SEPARATORS.has(hay[idx - 1]!)) score += BONUS_BOUNDARY;

    if (prevIdx !== -1) {
      const gap = idx - prevIdx - 1;
      score -= Math.min(gap * PENALTY_PER_GAP, PENALTY_GAP_CAP);
    }
    score += 1;
    prevIdx = idx;
    from = idx + 1;
  }

  // The compatibility hinge — see the module comment.
  const at = hay.indexOf(pin);
  if (at !== -1) {
    score += BONUS_SUBSTRING;
    if (at === 0 || SEPARATORS.has(hay[at - 1]!)) score += BONUS_SUBSTR_EDGE;
  }

  return score - haystack.length * PENALTY_LENGTH;
}
