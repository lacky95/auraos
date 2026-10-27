/**
 * Markdown for notification components (phase 6) — a small, DOM-free parser
 * for the common subset. `MarkdownField.ts` turns its tree into DOM nodes
 * with `createElement` / `textContent` only.
 *
 * Why our own parser and not markdown-it + a sanitizer: the tree has no
 * "html" node at all, so there is nothing to sanitise — raw HTML in the
 * source (`<script>`, `<img onerror>`, `<iframe>`) is plain text by
 * construction, and the renderer never calls innerHTML. A library would add
 * a dependency, an HTML string step and an allowlist post-pass that must be
 * right forever. The subset below is what agents write in reports.
 *
 * Supported (CommonMark / GFM flavoured, simplified):
 *   blocks   ATX + setext headings, paragraphs, fenced (``` / ~~~) and
 *            indented code, nested bullet / ordered lists, task items
 *            (`- [ ]` / `- [x]`), blockquotes, GFM tables (alignment), hr
 *   inline   **strong** / __strong__, *em* / _em_, ~~strike~~, `code`,
 *            [links](url "title"), <autolinks>, bare http(s):// URLs,
 *            ![images](url), backslash escapes, hard breaks (two spaces /
 *            backslash at the end of a line)
 *   not      raw HTML (stays text), reference links, footnotes, entities
 *            (`&amp;` stays as typed)
 *
 * Links: only absolute http(s) and mailto URLs become links (`safeLinkHref`);
 * anything else (`javascript:`, `data:`, `vbscript:`, relative paths) is
 * shown as text. Images are NEVER loaded (a sender-supplied remote image is
 * a tracking beacon): they become a link labelled with the alt text when the
 * URL is http(s), plain text otherwise.
 *
 * Bounded work: nesting depth is capped (MAX_DEPTH) and every inline search
 * remembers where it already failed, so a 64 KB input of `*` / `[` / `` ` ``
 * stays linear-ish instead of quadratic.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string | null; title?: string; c: Inline[] }
  | { t: 'image'; href: string | null; alt: string }
  | { t: 'br' };

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { t: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: 'paragraph'; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'list'; ordered: boolean; start: number; loose: boolean; items: ListItem[] }
  | { t: 'quote'; c: Block[] }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' };

export interface ListItem { task: boolean | null; c: Block[] }

export const MAX_DEPTH = 16;

/** http(s) / mailto only, absolute; null for anything else. */
export function safeLinkHref(raw: string): string | null {
  const s = raw.trim();
  if (!s || /[\u0000-\u001f\u007f]/.test(s)) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'mailto:') return null;
  if (u.protocol !== 'mailto:' && !u.hostname) return null;
  return u.href;
}

// ── Blocks ─────────────────────────────────────────────────────────────

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`]*?)[ \t]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function isBlank(l: string): boolean { return /^[ \t]*$/.test(l); }
function indentOf(l: string): number {
  let n = 0;
  for (const ch of l) { if (ch === ' ') n++; else if (ch === '\t') n += 4 - (n % 4); else break; }
  return n;
}
/** Remove up to `n` columns of leading indentation. */
function dedent(l: string, n: number): string {
  let i = 0;
  let col = 0;
  while (i < l.length && col < n) {
    if (l[i] === ' ') col++;
    else if (l[i] === '\t') col += 4 - (col % 4);
    else break;
    i++;
  }
  return l.slice(i);
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      if (inCode === 0) inCode = run; else if (inCode === run) inCode = 0;
      cur += s.slice(i, i + run);
      i += run - 1;
      continue;
    }
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function startsBlock(l: string): boolean {
  return FENCE.test(l) || ATX.test(l) || HR.test(l) || QUOTE.test(l) || /^ {0,3}([-*+]|1[.)])[ \t]+\S/.test(l);
}

export function parseBlocks(lines: string[], depth = 0): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) { i++; continue; }

    // Too deep: the rest is one paragraph of text.
    if (depth >= MAX_DEPTH) {
      out.push({ t: 'paragraph', c: [{ t: 'text', v: lines.slice(i).join('\n') }] });
      break;
    }

    const fence = FENCE.exec(line);
    if (fence && !(fence[2]![0] === '`' && fence[3]!.includes('`'))) {
      const ind = fence[1]!.length;
      const mark = fence[2]!;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        const close = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}[ \\t]*$`);
        if (close.test(l)) { i++; break; }
        body.push(dedent(l, ind));
        i++;
      }
      out.push({ t: 'code', lang: (fence[3] ?? '').split(/\s+/)[0]!.replace(/[^\w+#.-]/g, '').slice(0, 30), v: body.join('\n') });
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      out.push({ t: 'heading', level: atx[1]!.length as 1 | 2 | 3 | 4 | 5 | 6, c: parseInline(atx[2] ?? '', depth) });
      i++;
      continue;
    }

    if (HR.test(line)) { out.push({ t: 'hr' }); i++; continue; }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        if (QUOTE.test(l)) { inner.push(l.replace(QUOTE, '')); i++; continue; }
        // Lazy continuation of a quoted paragraph.
        if (!isBlank(l) && inner.length && !isBlank(inner[inner.length - 1]!) && !startsBlock(l)) { inner.push(l); i++; continue; }
        break;
      }
      out.push({ t: 'quote', c: parseBlocks(inner, depth + 1) });
      continue;
    }

    const item = ITEM.exec(line);
    if (item) {
      const r = parseList(lines, i, depth);
      out.push(r.block);
      i = r.next;
      continue;
    }

    if (indentOf(line) >= 4) {
      const body: string[] = [];
      while (i < lines.length && (indentOf(lines[i]!) >= 4 || isBlank(lines[i]!))) { body.push(dedent(lines[i]!, 4)); i++; }
      while (body.length && isBlank(body[body.length - 1]!)) body.pop();
      out.push({ t: 'code', lang: '', v: body.join('\n') });
      continue;
    }

    // GFM table: a header row, then a delimiter row with the same cell count.
    const next = lines[i + 1];
    if (line.includes('|') && next !== undefined && TABLE_DELIM.test(next) && next.includes('-')) {
      const head = splitRow(line);
      const delim = splitRow(next);
      if (head.length === delim.length) {
        const align: Align[] = delim.map((d) => {
          const l = d.startsWith(':');
          const r = d.endsWith(':');
          return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
        });
        const rows: Inline[][][] = [];
        i += 2;
        while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes('|') && !startsBlock(lines[i]!)) {
          const cells = splitRow(lines[i]!);
          rows.push(head.map((_, k) => parseInline(cells[k] ?? '', depth)));
          i++;
        }
        out.push({ t: 'table', align, head: head.map((h) => parseInline(h, depth)), rows });
        continue;
      }
    }

    // Paragraph (+ setext heading).
    const para: string[] = [line];
    i++;
    let setext: 1 | 2 | 0 = 0;
    while (i < lines.length) {
      const l = lines[i]!;
      if (isBlank(l)) break;
      const st = SETEXT.exec(l);
      if (st) { setext = st[1]![0] === '=' ? 1 : 2; i++; break; }
      if (startsBlock(l)) break;
      para.push(l);
      i++;
    }
    const text = para.map((p) => p.replace(/^[ \t]+/, '')).join('\n');
    out.push(setext ? { t: 'heading', level: setext, c: parseInline(text, depth) } : { t: 'paragraph', c: parseInline(text.replace(/[ \t]+$/, ''), depth) });
  }
  return out;
}

function parseList(lines: string[], from: number, depth: number): { block: Block; next: number } {
  const first = ITEM.exec(lines[from]!)!;
  const ordered = /\d/.test(first[2]!);
  const delim = ordered ? first[2]!.slice(-1) : first[2]!;
  const start = ordered ? Math.min(Number.parseInt(first[2]!, 10), 1e9) : 1;
  const items: ListItem[] = [];
  let loose = false;
  let pendingBlank = false;
  let i = from;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]!);
    if (!m) break;
    const isOrdered = /\d/.test(m[2]!);
    if (isOrdered !== ordered || (ordered ? m[2]!.slice(-1) : m[2]!) !== delim) break;
    if (HR.test(lines[i]!)) break;
    if (pendingBlank) loose = true;
    const spaces = m[3] ? indentOf(m[3]) : 1;
    const contentIndent = m[1]!.length + m[2]!.length + (spaces > 4 || !m[4] ? 1 : spaces);
    const body: string[] = [m[4] ?? ''];
    i++;
    let sawBlank = false;
    while (i < lines.length) {
      const l = lines[i]!;
      if (isBlank(l)) { body.push(''); sawBlank = true; i++; continue; }
      if (indentOf(l) >= contentIndent) { body.push(dedent(l, contentIndent)); i++; continue; }
      // Lazy paragraph continuation (no blank line before, not a block start).
      if (!sawBlank && !startsBlock(l) && !ITEM.test(l)) { body.push(l); i++; continue; }
      break;
    }
    // Trailing blank lines belong between items (they make the list loose
    // only when another item follows).
    let trailing = 0;
    while (body.length > 1 && body[body.length - 1] === '') { body.pop(); trailing++; }
    if (body.slice(1).some((b) => b === '')) loose = true;
    let task: boolean | null = null;
    const tm = /^\[([ xX])\](?:[ \t]+|$)/.exec(body[0]!);
    if (tm) { task = tm[1] !== ' '; body[0] = body[0]!.slice(tm[0].length); }
    items.push({ task, c: parseBlocks(body, depth + 1) });
    pendingBlank = trailing > 0;
  }
  return { block: { t: 'list', ordered, start, loose, items }, next: i };
}

// ── Inline ─────────────────────────────────────────────────────────────

const PUNCT = /[!-/:-@[-`{-~]/;
const BARE_URL = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** Split plain text at bare http(s) URLs (GFM autolink literal). */
function linkify(text: string, out: Inline[]): void {
  let last = 0;
  BARE_URL.lastIndex = 0;
  for (let m = BARE_URL.exec(text); m; m = BARE_URL.exec(text)) {
    let url = m[0];
    // Trailing punctuation is not part of the URL; an unbalanced ")" neither.
    while (/[.,;:!?*_~'"]$/.test(url)) url = url.slice(0, -1);
    while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
    const href = safeLinkHref(url);
    if (!href) continue;
    if (m.index > last) pushText(out, text.slice(last, m.index));
    out.push({ t: 'link', href, c: [{ t: 'text', v: url }] });
    last = m.index + url.length;
    BARE_URL.lastIndex = last;
  }
  if (last < text.length) pushText(out, text.slice(last));
}

function pushText(out: Inline[], v: string): void {
  if (!v) return;
  const prev = out[out.length - 1];
  if (prev && prev.t === 'text') prev.v += v; else out.push({ t: 'text', v });
}

/** Plain text of inline nodes (alt text, previews). */
export function inlineText(c: Inline[]): string {
  let s = '';
  for (const n of c) {
    if (n.t === 'text' || n.t === 'code') s += n.v;
    else if (n.t === 'br') s += ' ';
    else if (n.t === 'image') s += n.alt;
    else s += inlineText(n.c);
  }
  return s;
}

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  if (depth >= MAX_DEPTH) { pushText(out, src); return out; }
  // Matching brackets, computed once (escapes skipped).
  const close = new Map<number, number>();
  {
    const stack: number[] = [];
    for (let k = 0; k < src.length; k++) {
      const ch = src[k];
      if (ch === '\\') { k++; continue; }
      if (ch === '[') stack.push(k);
      else if (ch === ']' && stack.length) close.set(stack.pop()!, k);
    }
  }
  // Searches that already failed from some position on fail from later ones too.
  const failed = new Map<string, number>();
  const findCloser = (key: string, from: number, test: (at: number) => boolean, needle: string): number => {
    const f = failed.get(key);
    if (f !== undefined && from >= f) return -1;
    for (let at = src.indexOf(needle, from); at !== -1; at = src.indexOf(needle, at + 1)) {
      if (test(at)) return at;
    }
    failed.set(key, Math.min(f ?? Infinity, from));
    return -1;
  };

  // "[x](" without a valid destination: after a few, stop looking (bounded work).
  let destFails = 0;
  let text = '';
  const flush = () => { if (text) { linkify(text, out); text = ''; } };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    // Escapes.
    if (ch === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') { flush(); out.push({ t: 'br' }); i += 2; continue; }
      if (nx !== undefined && PUNCT.test(nx)) { text += nx; i += 2; continue; }
      text += ch; i++; continue;
    }
    // Hard break: two+ spaces before a newline.
    // `text` only ever holds the current line (flushed at every newline), so
    // the trailing-space check stays O(line).
    if (ch === '\n') {
      let k = text.length;
      while (k > 0 && text[k - 1] === ' ') k--;
      const hard = text.length - k >= 2;
      text = text.slice(0, k);
      if (hard) { flush(); out.push({ t: 'br' }); } else { text += '\n'; flush(); }
      i++;
      while (src[i] === ' ') i++;
      continue;
    }
    // Code span.
    if (ch === '`') {
      let run = 1;
      while (src[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const end = findCloser(`code${run}`, i + run, (at) => src[at - 1] !== '`' && src[at + run] !== '`', fence);
      if (end === -1) { text += fence; i += run; continue; }
      let v = src.slice(i + run, end).replace(/\n/g, ' ');
      if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ') && v.trim()) v = v.slice(1, -1);
      flush();
      out.push({ t: 'code', v });
      i = end + run;
      continue;
    }
    // Autolink <scheme:...>; anything else in <> (raw HTML) stays text.
    if (ch === '<') {
      const m = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/.exec(src.slice(i, i + 2100));
      if (m) {
        const href = safeLinkHref(m[1]!);
        flush();
        if (href) out.push({ t: 'link', href, c: [{ t: 'text', v: m[1]!.replace(/^mailto:/i, '') }] });
        else pushText(out, m[0]);
        i += m[0].length;
        continue;
      }
      text += ch; i++; continue;
    }
    // Links and images.
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const open = ch === '!' ? i + 1 : i;
      const end = close.get(open);
      if (end !== undefined && src[end + 1] === '(' && destFails < MAX_DEST_FAILS) {
        const dest = parseDest(src, end + 2);
        if (!dest) destFails++;
        if (dest) {
          const label = src.slice(open + 1, end);
          flush();
          if (ch === '!') {
            const alt = inlineText(parseInline(label, depth + 1));
            out.push({ t: 'image', href: safeLinkHref(dest.url), alt });
          } else {
            const node: Inline = { t: 'link', href: safeLinkHref(dest.url), c: stripLinks(parseInline(label, depth + 1)) };
            if (dest.title) (node as { title?: string }).title = dest.title;
            out.push(node);
          }
          i = dest.next;
          continue;
        }
      }
      text += ch; i++; continue;
    }
    // Emphasis / strong / strike.
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 1;
      while (src[i + run] === ch) run++;
      const prev = i > 0 ? src[i - 1]! : ' ';
      const after = src[i + run] ?? ' ';
      const leftFlanking = !/\s/.test(after) && !(ch === '_' && /[\p{L}\p{N}]/u.test(prev));
      if (ch === '~' ? run === 2 && leftFlanking : leftFlanking) {
        // Try the longest delimiter first (*** = strong + em).
        const sizes = ch === '~' ? [2] : run >= 2 ? [2, 1] : [1];
        let done = false;
        for (const size of sizes) {
          const needle = ch.repeat(size);
          const end = findCloser(`${ch}${size}`, i + size + 1, (at) => {
            const before = src[at - 1]!;
            const next = src[at + size] ?? ' ';
            if (/\s/.test(before)) return false;
            if (src[at + size] === ch && size === 1 && ch !== '~') return false;
            if (ch === '_' && /[\p{L}\p{N}]/u.test(next)) return false;
            return true;
          }, needle);
          if (end === -1) continue;
          flush();
          const inner = parseInline(src.slice(i + size, end), depth + 1);
          out.push({ t: ch === '~' ? 'del' : size === 2 ? 'strong' : 'em', c: inner });
          i = end + size;
          done = true;
          break;
        }
        if (done) continue;
      }
      text += ch.repeat(run);
      i += run;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

/** Links inside a link label are not links. */
function stripLinks(c: Inline[]): Inline[] {
  return c.flatMap((n): Inline[] => (n.t === 'link' ? n.c : [n]));
}

/** Longest link destination / title we look for (bounds the work per "[x](" ). */
const MAX_DEST = 2048;
const MAX_DEST_FAILS = 32;

function parseDest(src: string, from: number): { url: string; title?: string; next: number } | null {
  let i = from;
  const limit = Math.min(src.length, from + MAX_DEST);
  while (src[i] === ' ' || src[i] === '\n') i++;
  let url = '';
  if (src[i] === '<') {
    const end = src.indexOf('>', i + 1);
    if (end === -1 || end > limit || src.slice(i + 1, end).includes('\n')) return null;
    url = src.slice(i + 1, end);
    i = end + 1;
  } else {
    let depthP = 0;
    const startI = i;
    while (i < limit) {
      const ch = src[i]!;
      if (ch === '\\' && i + 1 < src.length) { i += 2; continue; }
      if (/\s/.test(ch)) break;
      if (ch === '(') depthP++;
      if (ch === ')') { if (depthP === 0) break; depthP--; }
      i++;
    }
    url = src.slice(startI, i).replace(/\\([!-/:-@[-`{-~])/g, '$1');
  }
  while (src[i] === ' ' || src[i] === '\n') i++;
  let title: string | undefined;
  const q = src[i];
  if (q === '"' || q === "'" || q === '(') {
    const endQ = q === '(' ? ')' : q;
    const end = src.indexOf(endQ, i + 1);
    if (end === -1 || end > limit) return null;
    title = src.slice(i + 1, end);
    i = end + 1;
    while (src[i] === ' ' || src[i] === '\n') i++;
  }
  if (src[i] !== ')') return null;
  return { url, ...(title ? { title } : {}), next: i + 1 };
}

/** Parse a whole document. */
export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, '\n').replace(/\u0000/g, '�').split('\n'));
}

/**
 * A short plain-text preview (pop-up / list): headings, paragraphs, list
 * items and quotes in order, code and tables summarised, whitespace
 * collapsed, cut at `max` chars. `truncated` says whether anything was cut.
 */
export function markdownPreview(src: string, max = 240): { text: string; truncated: boolean } {
  const parts: string[] = [];
  let len = 0;
  const walk = (blocks: Block[]): boolean => {
    for (const b of blocks) {
      if (len > max) return false;
      let s = '';
      if (b.t === 'heading' || b.t === 'paragraph') s = inlineText(b.c);
      else if (b.t === 'code') s = b.lang ? `[${b.lang} code]` : '[code]';
      else if (b.t === 'table') s = `[table: ${b.head.map(inlineText).join(' · ')}]`;
      else if (b.t === 'quote') { if (!walk(b.c)) return false; continue; }
      else if (b.t === 'list') {
        for (const it of b.items) {
          if (len > max) return false;
          const before = parts.length;
          if (!walk(it.c)) return false;
          if (it.task !== null && parts.length > before) parts[before] = `${it.task ? '☑' : '☐'} ${parts[before]}`;
          else if (parts.length > before) parts[before] = `• ${parts[before]}`;
        }
        continue;
      } else continue;
      s = s.replace(/\s+/g, ' ').trim();
      if (!s) continue;
      parts.push(s);
      len += s.length + 1;
    }
    return true;
  };
  walk(parseMarkdown(src.length > 20_000 ? src.slice(0, 20_000) : src));
  const full = parts.join(' · ');
  if (full.length <= max) return { text: full, truncated: false };
  return { text: `${full.slice(0, max).replace(/\s+\S*$/, '')}…`, truncated: true };
}
