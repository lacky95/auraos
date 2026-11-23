/**
 * The limited-IP setup bar's decisions (5.7, D15, D44). DOM-free. The address
 * always comes from the browser's own location, never from a request header.
 */
import {
  AURA_RESERVED_PATHS,
  classifyDesktopHost,
  suggestAppHostAddress,
  supportsAppHosts,
} from '@aura/core/host-rules';

export type SetupBarPlan =
  | { show: false }
  /** Probe `probeUrl`; show `href` if it answers, otherwise the guide. */
  | { show: true; kind: 'link'; href: string; address: string; probeUrl: string }
  | { show: true; kind: 'guide' };

export interface SetupBarInput {
  /** `location.host`. */
  host: string;
  /** `location.protocol`. */
  protocol: string;
  pathname?: string;
  /** How many apps are on `frameRoute: host`. PHASE2-CUTOVER: always show in direct IP mode. */
  hostRouteApps: number;
  webkit: boolean;
}

/** Safari and every iOS browser. Chromium also says AppleWebKit, so it is excluded. */
export function isWebKitBrowser(userAgent: string): boolean {
  if (!/AppleWebKit/i.test(userAgent)) return false;
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
  return !/Chrome|Chromium|CriOS|Edg|OPR|Android/i.test(userAgent);
}

export function planSetupBar(input: SetupBarInput): SetupBarPlan {
  if (input.hostRouteApps <= 0) return { show: false };
  if (supportsAppHosts(classifyDesktopHost(input.host))) return { show: false };
  const suggestion = suggestAppHostAddress(input.host);
  if (suggestion.kind !== 'switch') return { show: true, kind: 'guide' };
  const address = input.webkit && suggestion.webkitFallback ? suggestion.webkitFallback : suggestion.address;
  const base = `${input.protocol}//${address}`;
  return {
    show: true,
    kind: 'link',
    address: base,
    href: `${base}${input.pathname && input.pathname.startsWith('/') ? input.pathname : '/'}`,
    probeUrl: `${base}${AURA_RESERVED_PATHS.hostProbe}`,
  };
}

/** A link whose probe failed (DNS rebinding protection, usually) becomes the guide. */
export function settleSetupBar(plan: SetupBarPlan, probeOk: boolean): SetupBarPlan {
  return plan.show && plan.kind === 'link' && !probeOk ? { show: true, kind: 'guide' } : plan;
}

/** Any HTTP answer proves the name resolves and the server is reachable. */
export async function probeAppHostAddress(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 4000): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    await fetchImpl(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', redirect: 'manual', signal: ctl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
