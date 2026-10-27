/**
 * Presentation helpers for notifications — DOM-free and safe by
 * construction:
 *
 *   - text is never HTML: `textSegments()` splits it into plain text and
 *     http(s) links, which a renderer turns into text nodes and <a> elements
 *     (or `segmentsToHtml()` escapes everything for string templates);
 *   - only `http:` / `https:` URLs become links or external images;
 *   - images may also be same-origin paths (`/api/…`), never `data:`,
 *     `javascript:` or protocol-relative `//host`.
 *
 * There is no sanitizer library in the shell on purpose: nothing a sender
 * supplies is ever parsed as markup.
 */
import type { Notification } from './api.ts';

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string };

const HTML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESC[c] ?? c);
}

/** A normalised http(s) URL, or null. */
export function safeHttpUrl(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Image source: http(s), or a same-origin absolute path. Else null. */
export function safeImageSrc(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') && !/[\s"'<>]/.test(s)) return s;
  return safeHttpUrl(s);
}

// http(s)://… up to whitespace or a quote / angle bracket.
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
const TRAILING = /[.,;:!?]+$/;

function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING, '');
  // Drop unbalanced closing brackets: "(see https://x.y/a)" → "https://x.y/a".
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
    while (url.endsWith(close) && count(url, close) > count(url, open)) {
      url = url.slice(0, -1).replace(TRAILING, '');
    }
  }
  return url;
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/** Split text into plain segments and http(s) links. */
export function textSegments(text: string | undefined | null): Segment[] {
  const s = String(text ?? '');
  const out: Segment[] = [];
  let last = 0;
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(s); m; m = URL_RE.exec(s)) {
    const raw = trimUrl(m[0]);
    const href = safeHttpUrl(raw);
    if (!href) continue;
    if (m.index > last) out.push({ kind: 'text', text: s.slice(last, m.index) });
    out.push({ kind: 'link', text: raw, href });
    last = m.index + raw.length;
    URL_RE.lastIndex = last;
  }
  if (last < s.length) out.push({ kind: 'text', text: s.slice(last) });
  return out;
}

/** Escaped HTML for string templates: text escaped, links as safe anchors. */
export function segmentsToHtml(segments: Segment[]): string {
  return segments.map((seg) => seg.kind === 'text'
    ? escapeHtml(seg.text)
    : `<a href="${escapeHtml(seg.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(seg.text)}</a>`).join('');
}

/** "now", "5m", "3h", "2d", else a short date. */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const d = Math.max(0, now - ts);
  if (d < 45_000) return 'now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h`;
  if (d < 7 * 86_400_000) return `${Math.round(d / 86_400_000)}d`;
  const dt = new Date(ts);
  return dt.toISOString().slice(0, 10);
}

/** Absolute time for a tooltip / <time datetime>. */
export function isoTime(ts: number): string {
  return new Date(ts).toISOString();
}

export interface AppInfo {
  name: string;
  /** 1–3 char glyph, as on the dock tiles. */
  glyph?: string;
}
export type AppLookup = (appId: string) => AppInfo | undefined;

export interface SenderLabel {
  /** Main label, e.g. "Notes", "Agent tester", "REST API", "AuraOS". */
  label: string;
  /** Secondary detail, e.g. "via Shell Daemon". */
  detail?: string;
  /** 1–3 char glyph for the sender badge. */
  glyph: string;
  /** True when the sender identity is not verified (show a marker). */
  unverified: boolean;
  /** One line for screen readers and tooltips. */
  title: string;
}

function glyphOf(name: string): string {
  const t = name.trim();
  return (t ? t.charAt(0) : '?').toUpperCase();
}

/** Who sent it, for display. Never trusts a client-supplied name as verified. */
export function senderLabel(n: Pick<Notification, 'sender'>, lookup?: AppLookup): SenderLabel {
  const s = n.sender ?? { kind: 'unknown', attribution: 'unverified' };
  const unverified = s.attribution !== 'verified' && s.attribution !== 'internal';
  const app = s.id ? lookup?.(s.id) : undefined;
  let label: string;
  let detail: string | undefined;
  let glyph: string;
  switch (s.kind) {
    case 'auraos':
      label = s.name ?? 'AuraOS';
      glyph = 'OS';
      break;
    case 'agent': {
      const via = app?.name ?? s.name ?? s.id ?? 'Shell Daemon';
      label = s.actor?.name ? `Agent ${s.actor.name}` : 'Agent';
      detail = `via ${via}`;
      glyph = 'AI';
      break;
    }
    case 'rest':
      label = s.name ?? 'REST API';
      if (s.name) detail = 'REST API';
      glyph = 'API';
      break;
    case 'app':
      label = app?.name ?? s.name ?? s.id ?? 'App';
      glyph = (app?.glyph ?? glyphOf(label)).slice(0, 3).toUpperCase();
      if (s.actor?.name) detail = `by ${s.actor.name}`;
      break;
    default:
      label = s.name ?? 'Unknown sender';
      glyph = '?';
  }
  if (s.kind !== 'agent' && s.kind !== 'app' && s.actor?.name) detail = detail ? `${detail} · by ${s.actor.name}` : `by ${s.actor.name}`;
  const title = [label, detail, unverified ? '(unverified sender)' : ''].filter(Boolean).join(' ');
  return { label, ...(detail ? { detail } : {}), glyph, unverified, title };
}

export type IconSpec =
  | { kind: 'image'; src: string }
  | { kind: 'sprite'; name: string }
  | { kind: 'glyph'; text: string };

/**
 * The notification icon: an http(s) / same-origin image URL, a sprite name
 * (`lucide-…`), or a short text glyph. Falls back to the sender glyph.
 */
export function iconSpec(n: Pick<Notification, 'icon' | 'sender'>, lookup?: AppLookup): IconSpec {
  const raw = (n.icon ?? n.sender?.icon ?? '').trim();
  if (raw) {
    if (/^lucide-[a-z0-9-]{1,60}$/.test(raw)) return { kind: 'sprite', name: raw };
    const img = safeImageSrc(raw);
    if (img) return { kind: 'image', src: img };
    if ([...raw].length <= 3 && !/[<>&"']/.test(raw)) return { kind: 'glyph', text: raw };
  }
  return { kind: 'glyph', text: senderLabel(n, lookup).glyph };
}

export const PRIORITY_LABEL: Record<string, string> = {
  urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low',
};
