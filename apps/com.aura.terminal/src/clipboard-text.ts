// Text about to be written to the clipboard, made safe for iOS.
//
// When a page writes plain text to the iOS/iPadOS pasteboard, WebKit also
// checks whether that text PARSES AS A URL and, if so, adds a URL item in
// front of the text item. Anything starting with `word:` qualifies —
// "Username: gitlab-deploy…", "Token: …", "Note: …" — because `Username:` is
// a syntactically valid scheme (like `mailto:`). Paste in another app then
// takes the URL item, i.e. the text percent-encoded: spaces as %20, newlines
// as %0A, while ':' and '+' stay. That is the "sometimes my copy comes out
// encoded" report.
//
// Nothing in the clipboard API can opt out of that promotion, so the text is
// made to not parse as a URL: one zero-width space in front. A URL scheme
// must start with an ASCII letter and WebKit strips only C0 controls and
// spaces from the ends, so U+200B breaks the scheme without being visible.
// It is only added when needed — scheme-shaped start AND whitespace inside
// (a genuine single-token URL is left exactly as it is) — and only on iOS,
// where the promotion exists.

export const ZWSP = '​';

const SCHEME_START = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** True when WebKit on iOS would attach a URL item for this text. */
export function looksLikeUrlToIOS(text: string): boolean {
  // WebKit trims C0 controls and spaces before parsing.
  const t = text.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
  return SCHEME_START.test(t);
}

/** The text to actually write, given the platform. */
export function clipboardSafeText(text: string, isIOS: boolean): string {
  if (!isIOS || !text) return text;
  if (!looksLikeUrlToIOS(text)) return text;
  if (!/\s/.test(text.trim())) return text;   // a real URL: percent-encoding changes nothing
  return ZWSP + text;
}

/** iPhone/iPod, or an iPad (which reports itself as a Mac with touch). */
export function detectIOS(nav: { platform?: string; maxTouchPoints?: number; userAgent?: string } = navigator): boolean {
  const p = nav.platform ?? '';
  if (/iP(hone|ad|od)/.test(p)) return true;
  if (p === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1) return true;
  return /iP(hone|ad|od)/.test(nav.userAgent ?? '');
}
