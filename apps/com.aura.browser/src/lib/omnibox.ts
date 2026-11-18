// Pure address-bar logic shared by the page script and the API routes:
// URL-vs-search classification and the fuzzy ranking behind the suggestion
// dropdown. No DOM, no node imports — keep it that way so both sides can
// import it. Ported from the SteelAIBrowser omnibox, fixed to one engine.

export const SEARCH_ENGINE = { name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' };

export function searchUrl(query: string): string {
  return SEARCH_ENGINE.template.replace('%s', encodeURIComponent(query));
}

export type Classified = { kind: 'url'; url: string } | { kind: 'search'; query: string };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/;
const LOCALHOST = /^localhost(:\d+)?(\/.*)?$/i;
// Single-label intranet host with an explicit port (e.g. aura-shell:3000).
const HOST_PORT = /^[a-z0-9-]+:\d+([/?#].*)?$/i;
// host.tld with an alphabetic TLD of 2+ chars, optional port/path.
const DOMAIN = /^([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?([/?#].*)?$/i;

// Decide what the address bar should do with typed text. Anything with a
// space is a search (Chrome does the same), except an explicit scheme.
export function classifyInput(raw: string): Classified | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^(about|data|file):/i.test(s)) return { kind: 'url', url: s };
  if (/^https?:\/\/\S+$/i.test(s)) return { kind: 'url', url: s };
  if (/\s/.test(s)) return { kind: 'search', query: s };
  // `host:port` would otherwise look like a scheme.
  if (SCHEME.test(s) && !/^[^:]+:\d+/.test(s)) return { kind: 'search', query: s };
  if (LOCALHOST.test(s) || IPV4.test(s) || HOST_PORT.test(s)) return { kind: 'url', url: 'http://' + s };
  if (DOMAIN.test(s)) return { kind: 'url', url: 'https://' + s };
  return { kind: 'search', query: s };
}

export function resolveInput(raw: string): string | null {
  const c = classifyInput(raw);
  if (!c) return null;
  return c.kind === 'url' ? c.url : searchUrl(c.query);
}

// ---- fuzzy ranking -------------------------------------------------------

export interface Entry {
  url: string;
  title?: string;
  visitCount?: number;
  lastVisit?: number;
  bookmark?: boolean;
}

export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
}

// Subsequence match of `q` in `text`. 0 = no match. Consecutive runs, word
// boundaries and a match at the very start all score higher.
export function fuzzyScore(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const query = q.toLowerCase();
  const idx = t.indexOf(query);
  if (idx === 0) return 100 + query.length * 3;
  if (idx > 0) return (/[\s/.\-_?=&]/.test(t[idx - 1]) ? 70 : 50) + query.length * 2;
  let score = 0, ti = 0, run = 0;
  for (const ch of query) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    run = found === ti ? run + 1 : 0;
    score += 1 + run * 2 + (found === 0 || /[\s/.\-_]/.test(t[found - 1]) ? 3 : 0);
    ti = found + 1;
  }
  return Math.min(score, 45);
}

// Chrome-ish frecency: visits matter, recent visits matter more.
export function frecency(e: Entry, now = Date.now()): number {
  const ageDays = e.lastVisit ? (now - e.lastVisit) / 86_400_000 : 365;
  const recency = ageDays < 1 ? 1 : ageDays < 7 ? 0.7 : ageDays < 30 ? 0.4 : 0.15;
  return Math.log2(1 + (e.visitCount ?? 1)) * 10 * recency + (e.bookmark ? 15 : 0);
}

export function rankEntries(q: string, entries: Entry[], limit = 8, now = Date.now()): Entry[] {
  const query = q.trim();
  const scored: { e: Entry; s: number }[] = [];
  for (const e of entries) {
    const host = displayUrl(e.url);
    const m = Math.max(fuzzyScore(query, host) * 1.2, fuzzyScore(query, e.title ?? ''), fuzzyScore(query, e.url) * 0.8);
    if (query && m <= 0) continue;
    scored.push({ e, s: m + frecency(e, now) });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.e);
}

// Inline-autocomplete candidate: the displayed URL of the best entry whose
// host starts with what was typed (only for plain prefixes, no spaces).
export function inlineCompletion(q: string, ranked: Entry[]): string | null {
  if (!q || /\s/.test(q)) return null;
  const lq = q.toLowerCase();
  for (const e of ranked) {
    const d = displayUrl(e.url);
    if (d.toLowerCase().startsWith(lq) && d.length > q.length) return d;
  }
  return null;
}
