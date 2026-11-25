// Where an address may load in the engine frame, and with which sandbox.
// Pure, no DOM: the page script asks it before every navigation and after
// every load it can observe, and the tests pin each case.
//
// The engine pairs `allow-scripts` with `allow-same-origin` so that websites
// keep their own cookies and storage (sign-ins). That pair is only dangerous
// when the framed document is same-origin with this page, so nothing that
// can be is ever loaded with it:
//   external   any http(s) site that is not this desktop: its own origin, the
//              full sandbox. A redirect onto this desktop is stopped by the
//              target's `frame-ancestors` (the shell sends 'none', an App
//              Host allows only the shell, and the Browser's own App Host does
//              not allow itself), and caught by the load check if it slips.
//   app        another Aura app's App Host: never framed, it opens as its own
//              Activity. Its `frame-ancestors` would refuse this frame anyway.
//   self       the Browser's own App Host: refused.
//   shell      the desktop's own origin: refused.
//   refused    every other scheme (data:, blob:, about:, file:, javascript:,
//              …): they would run as an opaque or inherited origin with
//              nothing for the user to gain.
// A refused or reset frame shows about:blank under BLANK_SANDBOX, so even
// that empty document is opaque instead of inheriting this page's origin.
import { parseAppHost } from '@aura/app-sdk';

export type EngineKind = 'external' | 'app' | 'self' | 'shell' | 'refused';

export interface EngineTarget {
  kind: EngineKind;
  /** The address, normalised when it parses. */
  url: string;
}

/** Who this page is: its own App Host origin and the shell's. */
export interface EngineContext {
  selfOrigin: string;
  shellOrigin: string | null;
}

/** External sites: their own origin (sign-ins), no top navigation of the desktop. */
export const EXTERNAL_SANDBOX =
  'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
/** about:blank after a refusal or reset: no scripts and an opaque origin. */
export const BLANK_SANDBOX = '';
/**
 * Only the frame's first request uses it: a site's own links and sign-in
 * forms follow the site's own policy, so sites never learn the App Host's
 * address and their logins keep their Referer.
 */
export const ENGINE_REFERRER_POLICY = 'no-referrer';

export function sandboxFor(kind: EngineKind): string | null {
  return kind === 'external' ? EXTERNAL_SANDBOX : null;
}

function hostOf(origin: string | null): string | null {
  if (!origin) return null;
  try { return new URL(origin).host.toLowerCase(); } catch { return null; }
}

/** The desktop host this page belongs to: the part of its App Host after `--`. */
export function desktopHostOf(ctx: EngineContext): string | null {
  const shell = hostOf(ctx.shellOrigin);
  if (shell) return shell;
  return parseAppHost(hostOf(ctx.selfOrigin))?.base ?? null;
}

export function classifyEngineUrl(raw: string, ctx: EngineContext): EngineTarget {
  let u: URL;
  try { u = new URL(String(raw).trim()); } catch { return { kind: 'refused', url: String(raw) }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'refused', url: u.href };
  // Credentials in the authority are a spoofing trick here, never a login.
  if (u.username || u.password) return { kind: 'refused', url: u.href };
  const host = u.host.toLowerCase();
  if (host === hostOf(ctx.selfOrigin)) return { kind: 'self', url: u.href };
  const desktop = desktopHostOf(ctx);
  if (desktop && host === desktop) return { kind: 'shell', url: u.href };
  const app = parseAppHost(host);
  if (app && desktop && app.base === desktop) return { kind: 'app', url: u.href };
  return { kind: 'external', url: u.href };
}

/**
 * Whether a document this page can read may stay. Readable means same-origin
 * with this page. Only an `about:` document qualifies: the blank this page
 * set itself, or a browser error page (Firefox shows a refused frame as one).
 * Anything else readable is content served on this App Host, and is reset.
 */
export function readableLoadAllowed(href: string): boolean {
  return /^about:/i.test(href);
}
