/**
 * The setup bar's decisions (5.7, D15, D44). DOM-free. The address always
 * comes from the browser's own location, never from a request header.
 *
 * The bar shows for one of two reasons:
 *   `address`  this address can't carry App Hosts (direct IP, `localhost`);
 *   `cookies`  it can, but this browser drops the App Host cookie there, so
 *              every app frame would end on the sign-in page. WebKit does
 *              that on `*.localhost` (D44). It is found by behavior, with the
 *              cookie probe (`cookieProbeUrl`), not from the user agent.
 */
import {
  AURA_RESERVED_PATHS,
  buildAppHost,
  classifyDesktopHost,
  suggestAppHostAddress,
  supportsAppHosts,
  webkitSendsSiblingCookies,
} from '@aura/core/host-rules';

export type SetupBarReason = 'address' | 'cookies';

export type SetupBarPlan =
  | { show: false }
  /** Probe `probeUrl`; show `href` if it answers, otherwise the guide. */
  | { show: true; kind: 'link'; reason: SetupBarReason; href: string; address: string; probeUrl: string }
  | { show: true; kind: 'guide'; reason: SetupBarReason };

export interface SetupBarInput {
  /** `location.host`. */
  host: string;
  /** `location.protocol`. */
  protocol: string;
  pathname?: string;
  webkit: boolean;
}

/** Safari and every iOS browser. Chromium also says AppleWebKit, so it is excluded. */
export function isWebKitBrowser(userAgent: string): boolean {
  if (!/AppleWebKit/i.test(userAgent)) return false;
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
  return !/Chrome|Chromium|CriOS|Edg|OPR|Android/i.test(userAgent);
}

function linkPlan(input: SetupBarInput, reason: SetupBarReason, address: string): SetupBarPlan {
  const base = `${input.protocol}//${address}`;
  return {
    show: true,
    kind: 'link',
    reason,
    address: base,
    href: `${base}${input.pathname && input.pathname.startsWith('/') ? input.pathname : '/'}`,
    probeUrl: `${base}${AURA_RESERVED_PATHS.hostProbe}`,
  };
}

export function planSetupBar(input: SetupBarInput): SetupBarPlan {
  if (supportsAppHosts(classifyDesktopHost(input.host))) return { show: false };
  const suggestion = suggestAppHostAddress(input.host);
  if (suggestion.kind !== 'switch') return { show: true, kind: 'guide', reason: 'address' };
  const address = input.webkit && suggestion.webkitFallback ? suggestion.webkitFallback : suggestion.address;
  return linkPlan(input, 'address', address);
}

/** A link whose probe failed (DNS rebinding protection, usually) becomes the guide. */
export function settleSetupBar(plan: SetupBarPlan, probeOk: boolean): SetupBarPlan {
  return plan.show && plan.kind === 'link' && !probeOk ? { show: true, kind: 'guide', reason: plan.reason } : plan;
}

// ── the cookie probe (D44) ───────────────────────────────────────────────────

/**
 * The App Host name the cookie probe frame uses. Any well-formed name gets the
 * same answer (the router answers the probe before any lookup), so this one
 * needs no registry entry and reaches no app.
 */
export const COOKIE_PROBE_LABEL = 'hostprobe';

/**
 * Where to run the cookie probe, or null when there is no need: an address without App Hosts (`planSetupBar` covers it), or
 * one where every tested browser keeps the cookie (nip.io, a public suffix).
 */
export function cookieProbeUrl(input: Pick<SetupBarInput, 'host' | 'protocol'>): string | null {
  const desktop = classifyDesktopHost(input.host);
  if (!supportsAppHosts(desktop) || webkitSendsSiblingCookies(desktop)) return null;
  const host = buildAppHost(COOKIE_PROBE_LABEL, input.host);
  return host ? `${input.protocol}//${host}${AURA_RESERVED_PATHS.hostProbe}?cookie=set` : null;
}

/**
 * The bar once the probe saw this browser drop the cookie: a link to the
 * address that works there (`127-0-0-1.nip.io` for `os.aura.localhost`), or
 * the guide when there is none.
 */
export function planCookieFallback(input: SetupBarInput): SetupBarPlan {
  const suggestion = suggestAppHostAddress(input.host);
  const fallback = suggestion.kind === 'custom-domain' ? undefined : suggestion.webkitFallback;
  if (!fallback) return { show: true, kind: 'guide', reason: 'cookies' };
  return linkPlan(input, 'cookies', fallback);
}

/**
 * Whether this browser keeps an App Host cookie set in a frame, as a real app
 * frame's handoff does: a hidden frame with the app frames' sandbox loads
 * `url`, and the router's check page posts the answer to this exact desktop.
 * Resolves true when the probe can't tell (no answer in time), so a slow or
 * unreachable address never shows the bar by itself.
 */
export function probeAppHostCookie(url: string, opts: { sandbox: string; timeoutMs?: number; doc?: Document; win?: Window }): Promise<boolean> {
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;
  const origin = new URL(url).origin;
  return new Promise((resolve) => {
    const frame = doc.createElement('iframe');
    frame.setAttribute('sandbox', opts.sandbox);
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;';
    const finish = (kept: boolean) => {
      win.removeEventListener('message', onMessage);
      clearTimeout(timer);
      frame.remove();
      resolve(kept);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.contentWindow) return;
      const data = e.data as { type?: unknown; cookie?: unknown } | null;
      if (!data || data.type !== 'aura.hostprobe.cookie') return;
      finish(data.cookie === true);
    };
    const timer = setTimeout(() => finish(true), opts.timeoutMs ?? 8000);
    win.addEventListener('message', onMessage);
    frame.src = url;
    doc.body.appendChild(frame);
  });
}

/**
 * Any HTTP answer proves the name resolves and the server is reachable.
 * `no-cors` only allows the default `redirect: follow`: any other mode makes
 * every browser reject the fetch, so the probe would always fail.
 */
export async function probeAppHostAddress(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 4000): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    await fetchImpl(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
