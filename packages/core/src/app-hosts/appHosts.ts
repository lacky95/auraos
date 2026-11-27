/**
 * App hosts — an app (or one of its sidecars) served at the root of its own
 * host name, `{name}--{host the desktop is on}`, same scheme and port:
 *
 *   http://10-201-1-2.nip.io:3000        → http://marklayer--10-201-1-2.nip.io:3000
 *   https://lukas-01.aura.int.lakner.io  → https://marklayer--lukas-01.aura.int.lakner.io
 *
 * `--` rather than a dot: a wildcard certificate covers one label, so
 * `*.aura.int.lakner.io` serves every machine and every app. The shell routes
 * by Host header (packages/shell/server/app-hosts.mjs). The rules live in
 * hostRules.ts; everything here is pure so both sides and the tests share one
 * definition. Docs: /docs/app-hosts.
 */

import { isRawIpHost, isValidHostName, parseAppHost } from '../types/hostRules.js';

export * from '../types/hostRules.js';

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
