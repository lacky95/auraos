/**
 * Scored fuzzy matching for shell search boxes.
 *
 * A query token matches a field only when the match means something: the
 * whole field, a prefix, a whole word, a word start, a substring (2+ chars),
 * or the field's word initials ("sab" → Steel AI Browser). Plain scattered
 * subsequences are deliberately NOT a match — they made "term" hit
 * "te-l-e-g-r-a-m" and short queries hit nearly everything.
 */

/** Lowercased words of a field: split on non-alphanumerics and camelCase,
 *  including acronyms ("SteelAIBrowser" → steel ai browser). */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** How well one lowercased token matches one field; null = no match. */
export function tokenScore(tok: string, field: string): number | null {
  const f = field.toLowerCase();
  if (f === tok) return 100;
  if (f.startsWith(tok)) return 90;
  const ws = words(field);
  if (ws.some(w => w === tok)) return 85;
  if (ws.some(w => w.startsWith(tok))) return 80;
  // One letter mid-word matches nearly everything, so it needs a word start.
  if (tok.length >= 2 && f.includes(tok)) return 60;
  // Initials: "sab" → Steel AI Browser. Each char starts the next word.
  if (tok.length >= 2) {
    let i = 0;
    for (const w of ws) if (i < tok.length && w[0] === tok[i]) i++;
    if (i === tok.length) return 50;
  }
  return null;
}

/**
 * Score a query against weighted fields. Every whitespace-separated token must
 * match some field; each token contributes its best (score + field weight).
 * Returns null when any token matches nothing, 0 for an empty query.
 */
export function fuzzyScore(query: string, fields: Array<[string | null | undefined, number]>): number | null {
  let total = 0;
  for (const tok of query.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    let best: number | null = null;
    for (const [text, weight] of fields) {
      if (!text) continue;
      const sc = tokenScore(tok, text);
      if (sc !== null && (best === null || sc + weight > best)) best = sc + weight;
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}
