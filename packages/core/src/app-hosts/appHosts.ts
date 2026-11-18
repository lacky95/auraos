/**
 * App hosts — an app (or one of its sidecars) served at the root of its own
 * host name, `{name}--{host the desktop is on}`, same scheme and port:
 *
 *   http://10-201-1-2.nip.io:3000        → http://marklayer--10-201-1-2.nip.io:3000
 *   https://lukas-01.aura.int.lakner.io  → https://marklayer--lukas-01.aura.int.lakner.io
 *
 * `--` rather than a dot: a wildcard certificate covers one label, so
 * `*.aura.int.lakner.io` serves every machine and every app. The shell routes
 * by Host header (packages/shell/server/app-hosts.mjs, which mirrors
 * `parseAppHost` in plain JS); everything here is pure so both sides and the
 * tests share one definition. Docs: /docs/app-hosts.
 */

/**
 * Letters and digits only: nip.io reads a hyphen before `--` as part of an
 * IPv6 address (`a-b--10-201-1-2.nip.io` → `a:b::10:201:1:2`).
 */
export const HOST_NAME_RE = /^[a-z][a-z0-9]{0,30}$/;

/**
 * Names no app may take. `xn` keeps punycode hosts (`xn--…`) on the desktop;
 * the rest are names a person would expect to be the OS itself.
 */
export const RESERVED_HOST_NAMES: ReadonlySet<string> = new Set([
  'aura', 'shell', 'os', 'api', 'www', 'admin', 'app', 'apps', 'xn',
]);

export function isValidHostName(name: string): boolean {
  return HOST_NAME_RE.test(name) && !RESERVED_HOST_NAMES.has(name);
}

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

/** `10.0.0.2`, `10.0.0.2:3000`, `[::1]:3000`, `localhost`: no label can be prepended. */
export function isRawIpHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) return true;                      // IPv6 literal
  const name = h.replace(/:\d+$/, '');
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name === 'localhost' || !name.includes('.');
}

/**
 * The URL of app host `name` for a desktop opened at `scheme://host`, or null
 * when `host` has no label to prepend (a raw IP, `localhost`, a single-label
 * name such as `aura-shell:3000`).
 */
export function appHostUrl(name: string, desktop: { scheme: string; host: string }): string | null {
  if (!isValidHostName(name) || !desktop.host || isRawIpHost(desktop.host)) return null;
  const scheme = desktop.scheme.replace(/:$/, '') === 'https' ? 'https' : 'http';
  // A request that already arrived on an app host: build from its desktop part.
  const base = parseAppHost(desktop.host)?.base ?? desktop.host.trim().toLowerCase();
  return `${scheme}://${name}--${base}`;
}

/** One app's claim on host names, as `hostConflicts` reads it. */
export interface HostClaim {
  appId: string;
  hosts: ReadonlyArray<{ name: string }>;
}

/**
 * Host names `candidate` declares that another installed app already holds.
 * The same app id (an update, or a user-scope app shadowing its global copy)
 * never conflicts with itself.
 */
export function hostConflicts(candidate: HostClaim, installed: readonly HostClaim[]): Array<{ name: string; heldBy: string }> {
  const held = new Map<string, string>();
  for (const a of installed) {
    if (a.appId === candidate.appId) continue;
    for (const h of a.hosts) if (!held.has(h.name)) held.set(h.name, a.appId);
  }
  const out: Array<{ name: string; heldBy: string }> = [];
  for (const h of candidate.hosts) {
    const by = held.get(h.name);
    if (by) out.push({ name: h.name, heldBy: by });
  }
  return out;
}
