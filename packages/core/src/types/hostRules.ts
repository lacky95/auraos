/**
 * App host rules: the one definition of how `{name}--{desktop host}` is parsed,
 * built and named. Pure, with no imports, so it runs in the shell server, the
 * browser and an installed app alike.
 *
 * The source is packages/core/src/types/hostRules.ts. The SDK carries a
 * byte-identical copy at packages/app-sdk/src/hostRules.ts, because an app can
 * install @aura/app-sdk without @aura/core. core's host-rules test fails if
 * the two differ. Docs: /docs/app-hosts.
 */

// ── names ────────────────────────────────────────────────────────────────────

/**
 * Letters and digits only: nip.io reads a hyphen before `--` as part of an
 * IPv6 address (`a-b--10-201-1-2.nip.io` → `a:b::10:201:1:2`).
 */
export const HOST_NAME_RE = /^[a-z][a-z0-9]{0,30}$/;

export const MAX_HOST_NAME_LENGTH = 31;
/** The whole first DNS label, `{name}--{first label of the desktop host}`. */
export const MAX_DNS_LABEL_LENGTH = 63;
/** Readable part of a generated name: the last app id part. */
export const MAX_APP_NAME_PART_LENGTH = 19;
export const ORIGIN_HASH_LENGTH = 8;
/** `x999` is the longest suffix that keeps a 27-char base within 31. */
export const MAX_APP_HOST_SLOT = 999;
/** Prefix for an app whose own name can't be shown (look-alike, or no letters first). */
export const NEUTRAL_HOST_PREFIX = 'app';

/**
 * Names no app may take. `xn` keeps punycode hosts (`xn--…`) on the desktop;
 * the rest are names a person would expect to be the OS itself.
 */
export const RESERVED_HOST_NAMES: ReadonlySet<string> = new Set([
  'aura', 'shell', 'os', 'api', 'www', 'admin', 'app', 'apps', 'xn',
]);

/**
 * Last id part of every app shipped in `apps/`. Only a system app may be named
 * after one; anything else gets the neutral prefix. Kept apart from
 * RESERVED_HOST_NAMES so that `isValidHostName` keeps its current answers until
 * the registry starts enforcing this set.
 */
export const SYSTEM_APP_HOST_NAMES: ReadonlySet<string> = new Set([
  'aurashelld', 'browser', 'console', 'counter', 'docs', 'example',
  'nexus', 'notepad', 'registry', 'settings', 'terminal',
]);

export function isValidHostName(name: string): boolean {
  return HOST_NAME_RE.test(name) && !RESERVED_HOST_NAMES.has(name);
}

/** Reserved for the OS, or the name of a system app. */
export function isProtectedHostName(name: string): boolean {
  return RESERVED_HOST_NAMES.has(name) || SYSTEM_APP_HOST_NAMES.has(name);
}

// ── parsing and building ─────────────────────────────────────────────────────

/** A host header split into the app host name and the desktop's host, or null. */
export interface ParsedAppHost {
  /** The app host name (the label before `--`). */
  name: string;
  /** The desktop's host, port included (`lukas-01.aura.int.lakner.io`, `10-201-1-2.nip.io:3000`). */
  base: string;
}

/**
 * Parse a Host header. Only the syntax is checked: whether `name` belongs to
 * an installed app is the router's question.
 */
export function parseAppHost(host: string | null | undefined): ParsedAppHost | null {
  if (!host) return null;
  const h = host.trim().toLowerCase();
  const at = h.indexOf('--');
  if (at <= 0) return null;
  const name = h.slice(0, at);
  const base = h.slice(at + 2);
  // The name is the whole first label, and something must follow it.
  if (!isValidHostName(name) || !base || base.startsWith('.') || base.startsWith(':')) return null;
  return { name, base };
}

/** The desktop part of a host that may itself be an app host (`x--desk` → `desk`). */
export function desktopPart(host: string): string {
  const h = host.trim().toLowerCase();
  const at = h.indexOf('--');
  return at > 0 && HOST_NAME_RE.test(h.slice(0, at)) ? h.slice(at + 2) : h;
}

/** `10.0.0.2`, `10.0.0.2:3000`, `[::1]:3000`, `localhost`: no label can be prepended. */
export function isRawIpHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) return true;                      // IPv6 literal
  const name = h.replace(/:\d+$/, '');
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name === 'localhost' || !name.includes('.');
}

/**
 * `{name}--{desktopHost}`, or null when the name is invalid, the desktop host
 * can't carry App Hosts, or the first DNS label would pass 63 characters.
 */
export function buildAppHost(name: string, desktopHost: string): string | null {
  if (!isValidHostName(name)) return null;
  const desktop = classifyDesktopHost(desktopHost);
  if (!supportsAppHosts(desktop)) return null;
  const firstLabel = desktop.hostname.split('.')[0] ?? '';
  if (name.length + 2 + firstLabel.length > MAX_DNS_LABEL_LENGTH) return null;
  return `${name}--${desktop.hostname}${desktop.port === null ? '' : `:${desktop.port}`}`;
}

// ── generated names ──────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/;

export interface AppHostNameInput {
  appId: string;
  /** Manifest `originId`. Absent or not hex-led: the installation id is used. */
  originId?: string | null;
  /** Local UUID of this installation. Supplies every retry suffix. */
  installationId: string;
  /** From the install scope, never inferred from the app id. */
  isSystemApp: boolean;
  /** 0 proposes the normal name. Each retry after a collision takes a new suffix. */
  attempt?: number;
}

/** Readable part of the name: the last id part, unless it would impersonate the OS. */
function appNamePart(appId: string, isSystemApp: boolean): string {
  const last = appId.slice(appId.lastIndexOf('.') + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!isSystemApp && isProtectedHostName(last)) return NEUTRAL_HOST_PREFIX;
  const named = /^[a-z]/.test(last) ? last : `${NEUTRAL_HOST_PREFIX}${last}`;
  return named.slice(0, MAX_APP_NAME_PART_LENGTH);
}

/**
 * Propose a slot-1 host name: last app id part + 8 hex characters. Only a
 * proposal: the registry allocates it once and stays the authority. A retry
 * never reuses `originId`, which an app can copy; it reads further along the
 * local installation id. Throws RangeError when those run out.
 */
export function proposeAppHostName(input: AppHostNameInput): string {
  const installation = input.installationId.trim().toLowerCase();
  if (!UUID_RE.test(installation)) throw new TypeError('installationId must be a UUID');
  const attempt = input.attempt ?? 0;
  if (!Number.isInteger(attempt) || attempt < 0) throw new RangeError('attempt must be a non-negative integer');
  const origin = (input.originId ?? '').trim().toLowerCase();
  const originHash = /^[0-9a-f]{8}/.test(origin) ? origin.slice(0, ORIGIN_HASH_LENGTH) : null;
  let hash: string;
  if (originHash && attempt === 0) hash = originHash;
  else {
    const hex = installation.replace(/-/g, '');
    const at = originHash ? attempt - 1 : attempt;
    if (at + ORIGIN_HASH_LENGTH > hex.length) throw new RangeError('no host name suffix left');
    hash = hex.slice(at, at + ORIGIN_HASH_LENGTH);
  }
  return `${appNamePart(input.appId, input.isSystemApp)}${hash}`;
}

/** The host name of `slot`: slot 1 is the name itself, slot N adds `xN`. */
export function appHostNameForSlot(name: string, slot: number): string {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_APP_HOST_SLOT) {
    throw new RangeError(`slot must be an integer from 1 to ${MAX_APP_HOST_SLOT}`);
  }
  const named = slot === 1 ? name : `${name}x${slot}`;
  if (!isValidHostName(named)) throw new RangeError(`invalid app host name: ${named}`);
  return named;
}

// ── desktop host classification ──────────────────────────────────────────────

export const LOCAL_AURA_HOST = 'os.aura.localhost';
const LOOPBACK_NIP_HOST = '127-0-0-1.nip.io';

/** Suffixes that are not public: WebKit rejects sibling cookies on them (D44). */
const NON_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  'arpa', 'corp', 'example', 'home', 'internal', 'intranet', 'invalid',
  'lan', 'local', 'localdomain', 'onion', 'test',
]);

interface DesktopHostAddress {
  /** Lowercase, without brackets or port. */
  hostname: string;
  port: number | null;
}

export type DesktopHostClass =
  | { kind: 'invalid' }
  | (DesktopHostAddress & { kind: 'ip'; family: 4 | 6; loopback: boolean; isPrivate: boolean })
  /** `localhost` or `*.localhost`, including bare `aura.localhost`: not an App Host base (D44). */
  | (DesktopHostAddress & { kind: 'loopback-name' })
  | (DesktopHostAddress & { kind: 'local-aura' })
  /** The canonical `a-b-c-d.nip.io`. */
  | (DesktopHostAddress & { kind: 'nip'; ipv4: string; loopback: boolean })
  | (DesktopHostAddress & { kind: 'custom'; publicSuffix: boolean });

export type DesktopHostKind = DesktopHostClass['kind'];
/** The classes `{name}--{host}` can be built on. */
export type AppHostDesktop = Extract<DesktopHostClass, { kind: 'local-aura' | 'nip' | 'custom' }>;

function parseIpv4(s: string): [number, number, number, number] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255) return null;
    out.push(Number(p));
  }
  return out as [number, number, number, number];
}

function isLoopbackIpv4(ip: readonly number[]): boolean {
  return ip[0] === 127;
}

/** RFC 1918, carrier-grade NAT (Tailscale and similar), and link-local. */
function isPrivateIpv4(ip: readonly number[]): boolean {
  const a = ip[0] ?? 0;
  const b = ip[1] ?? 0;
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254);
}

/** The eight 16-bit groups of an IPv6 literal, or null. */
function parseIpv6(s: string): number[] | null {
  let text = s;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.')) {
    if (lastColon < 0) return null;
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    text = text.slice(0, lastColon + 1);
    // `::1.2.3.4` leaves `::`; `a:1.2.3.4` leaves `a:`, whose colon is only a separator.
    if (!text.endsWith('::')) text = text.slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string | undefined): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groups(halves[0]);
  const rest = groups(halves[1]);
  if (!head || !rest) return null;
  const count = head.length + rest.length + tail.length;
  if (halves.length === 1) return count === 8 ? [...head, ...tail] : null;
  if (count > 7) return null;
  return [...head, ...new Array<number>(8 - count).fill(0), ...rest, ...tail];
}

function classifyIpv6(hostname: string, port: number | null): DesktopHostClass {
  const g = parseIpv6(hostname);
  if (!g) return { kind: 'invalid' };
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  const mapped = zeros(5) && g[5] === 0xffff;
  const loopback = (zeros(7) && g[7] === 1) || (mapped && (g[6] ?? 0) >> 8 === 127);
  return { kind: 'ip', hostname, port, family: 6, loopback, isPrivate: false };
}

/**
 * What kind of address the desktop was opened at. Strict by design: this is
 * the input to the Host allowlist, so anything unusual is `invalid`. That
 * includes a host that is already an App Host (`x--desk.example`), a trailing
 * dot, an unbracketed IPv6 address, and a single-label name.
 */
export function classifyDesktopHost(host: string | null | undefined): DesktopHostClass {
  if (!host) return { kind: 'invalid' };
  const h = host.trim().toLowerCase();
  const m = h.match(/^(?:\[([0-9a-f:.]+)\]|([a-z0-9.-]+))(?::([1-9]\d{0,4}))?$/);
  if (!m) return { kind: 'invalid' };
  const port = m[3] ? Number(m[3]) : null;
  if (port !== null && port > 65535) return { kind: 'invalid' };
  if (m[1]) return classifyIpv6(m[1], port);

  const hostname = m[2] ?? '';
  if (hostname.length > 253) return { kind: 'invalid' };
  const labels = hostname.split('.');
  if (!labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return { kind: 'invalid' };

  const tld = labels[labels.length - 1] ?? '';
  if (/^\d+$/.test(tld)) {
    const ip = parseIpv4(hostname);
    if (!ip) return { kind: 'invalid' };
    const loopback = isLoopbackIpv4(ip);
    return { kind: 'ip', hostname, port, family: 4, loopback, isPrivate: !loopback && isPrivateIpv4(ip) };
  }

  const first = labels[0] ?? '';
  if (first.includes('--') && !first.startsWith('xn--')) return { kind: 'invalid' };
  if (hostname === LOCAL_AURA_HOST) return { kind: 'local-aura', hostname, port };
  if (tld === 'localhost') return { kind: 'loopback-name', hostname, port };
  if (labels.length === 1) return { kind: 'invalid' };

  if (labels.length === 3 && labels[1] === 'nip' && tld === 'io' && /^\d+(-\d+){3}$/.test(first)) {
    const ipv4 = first.replace(/-/g, '.');
    const ip = parseIpv4(ipv4);
    if (!ip) return { kind: 'invalid' };
    return { kind: 'nip', hostname, port, ipv4, loopback: isLoopbackIpv4(ip) };
  }
  return { kind: 'custom', hostname, port, publicSuffix: !NON_PUBLIC_SUFFIXES.has(tld) };
}

export function supportsAppHosts(desktop: DesktopHostClass): desktop is AppHostDesktop {
  return desktop.kind === 'local-aura' || desktop.kind === 'nip' || desktop.kind === 'custom';
}

/** Whether WebKit sends sibling cookies on this address (D44). */
export function webkitSendsSiblingCookies(desktop: AppHostDesktop): boolean {
  if (desktop.kind === 'local-aura') return false;
  return desktop.kind === 'nip' || desktop.publicSuffix;
}

export type AppHostSuggestion =
  /** This address already carries App Hosts. */
  | { kind: 'current'; address: string; webkitFallback?: string }
  /** Offer a link to this address. Open `webkitFallback` instead on WebKit. */
  | { kind: 'switch'; address: string; webkitFallback?: string }
  /** No address can be derived: show the custom-domain guide. */
  | { kind: 'custom-domain' };

/**
 * Which address to offer for the host the desktop is on. Pass the browser's
 * own `location.host`, never a request header (5.7). Only private IPv4 gets a
 * nip.io link; public and other IPv6 addresses get the custom-domain guide.
 */
export function suggestAppHostAddress(host: string | null | undefined): AppHostSuggestion {
  const d = classifyDesktopHost(host);
  if (d.kind === 'invalid') return { kind: 'custom-domain' };
  const at = (hostname: string) => `${hostname}${d.port === null ? '' : `:${d.port}`}`;
  switch (d.kind) {
    case 'local-aura':
      return { kind: 'current', address: at(d.hostname), webkitFallback: at(LOOPBACK_NIP_HOST) };
    case 'nip':
    case 'custom':
      return { kind: 'current', address: at(d.hostname) };
    case 'loopback-name':
      return { kind: 'switch', address: at(LOCAL_AURA_HOST), webkitFallback: at(LOOPBACK_NIP_HOST) };
    case 'ip':
      if (d.loopback) return { kind: 'switch', address: at(LOCAL_AURA_HOST), webkitFallback: at(LOOPBACK_NIP_HOST) };
      if (d.family === 4 && d.isPrivate) return { kind: 'switch', address: at(`${d.hostname.replace(/\./g, '-')}.nip.io`) };
      return { kind: 'custom-domain' };
  }
}

// ── reserved paths, header and cookie names ──────────────────────────────────

/** Paths on every App Host that the router answers and the app never sees. */
export const AURA_RESERVED_PATHS = {
  handoff: '/_aura/handoff',
  runtime: '/_aura/runtime.js',
  /** Prefix of the same-origin shell gateway. */
  os: '/_aura/os/',
  hostProbe: '/_aura/host-probe',
} as const;

export const AURA_RESERVED_PREFIX = '/_aura/';

/**
 * Set to `host` by the router on a request it serves from a verified App Host,
 * and removed from every other request. It selects URLs (no base path) and
 * grants nothing.
 */
export const APP_HOST_ROUTE_HEADER = 'x-aura-frame-route';

/**
 * Whether a raw request path falls under `/_aura`, after resolving dot
 * segments, slashes, one layer of percent-encoding and case. A path that can't
 * be decoded counts as reserved, so it can't slip past the router to the app.
 */
export function isAuraReservedPath(path: string): boolean {
  const p = normalizedRequestPath(path);
  return p === null || p === '/_aura' || p.startsWith(AURA_RESERVED_PREFIX);
}

/**
 * A raw request path with dot segments, slashes, one layer of
 * percent-encoding and case resolved; null when it can't be decoded.
 */
function normalizedRequestPath(path: string): string | null {
  try {
    const raw = path.split(/[?#]/, 1)[0] ?? '';
    const slashed = `/${raw.replace(/\\/g, '/')}`.replace(/\/{2,}/g, '/');
    const decoded = decodeURIComponent(new URL(slashed, 'http://h').pathname).replace(/\\/g, '/');
    return new URL(`/${decoded}`.replace(/\/{2,}/g, '/'), 'http://h').pathname.toLowerCase();
  } catch {
    return null;
  }
}

// ── lifecycle routes ─────────────────────────────────────────────────────────

/**
 * Carries the per-start lifecycle secret (`AURA_LIFECYCLE_TOKEN`) from the
 * kernel to an app's `/api/lifecycle/*` routes. Only the runner sends it; the
 * shell removes it from every request it forwards to an app.
 */
export const LIFECYCLE_TOKEN_HEADER = 'x-aura-lifecycle';

/** The one lifecycle route that also answers without the token (other probes). */
export const LIFECYCLE_HEALTH_PATH = '/api/lifecycle/health';

/**
 * The normalized form of a request path under `/api/lifecycle` (the same
 * resolution as `isAuraReservedPath`, without a trailing slash), or null for
 * any other path. An `/api/` path that can't be decoded counts as a lifecycle
 * path, so an encoding trick can't slip a hook call past a guard.
 */
export function lifecycleRequestPath(path: string): string | null {
  const p = normalizedRequestPath(path);
  if (p === null) return /^[/\\]+api[/\\]/i.test(path) ? '/api/lifecycle/?' : null;
  const trimmed = p.length > 1 ? p.replace(/\/+$/, '') : p;
  return trimmed === '/api/lifecycle' || trimmed.startsWith('/api/lifecycle/') ? trimmed : null;
}

/** Header carrying the signed app identity from the gateway to the shell API. */
export const GATEWAY_IDENTITY_HEADER = 'x-aura-gateway-identity';

/**
 * Header carrying the signed owner claim from the router to a trusted system
 * UI's own server (D45), which sends it back to the shell API with its
 * instance token on the reads its pages make. Removed from every inbound
 * request and every response.
 */
export const OWNER_SSR_HEADER = 'x-aura-owner-ssr';

/** The host-only app cookie. `__Host-` on HTTPS stops a sibling planting it. */
export function appHostCookieName(secure: boolean): string {
  return secure ? '__Host-aura_app' : 'aura_app';
}
