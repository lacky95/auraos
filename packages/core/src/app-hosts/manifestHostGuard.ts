/**
 * Which `hosts[]` of a loaded manifest take effect. AppRegistry applies this
 * to every manifest, so an app that arrives by clone, scaffold or a copied
 * directory can't claim a name the install check would have refused.
 *
 * A name is dropped when another app already holds it, when it names the OS or
 * a system app and was not accepted before (`known`), or when it is an
 * allocated App Host label. System-scope manifests are trusted as shipped.
 */
import { isProtectedHostName } from '../types/hostRules.js';

interface HostHolder { id: string; hosts: ReadonlyArray<{ name: string }> }

export const manifestHostClaim = (appId: string, name: string) => `${appId}|${name}`;

export class ManifestHostGuard {
  /** Null until the known claims are recorded: protected names aren't judged yet. */
  private known: Set<string> | null = null;
  private readonly blocked = new Set<string>();

  setKnown(claims: ReadonlySet<string> | null): void {
    this.known = claims ? new Set(claims) : null;
  }

  addKnown(claims: readonly string[]): void {
    for (const c of claims) this.known?.add(c);
  }

  /** Stop `appId` from using `name`, an App Host label someone else owns. */
  block(appId: string, name: string): void {
    this.blocked.add(manifestHostClaim(appId, name));
  }

  /** The hosts `m` may use. Returns `m.hosts` itself when nothing was dropped. */
  filter<H extends { name: string }>(m: { id: string; scopeId: string; hosts: H[] }, others: Iterable<HostHolder>): H[] {
    if (m.scopeId === 'system' || m.hosts.length === 0) return m.hosts;
    const held = new Map<string, string>();
    for (const o of others) {
      if (o.id === m.id) continue;
      for (const h of o.hosts) if (!held.has(h.name)) held.set(h.name, o.id);
    }
    const kept = m.hosts.filter((h) => {
      const claim = manifestHostClaim(m.id, h.name);
      let why: string | null = null;
      if (held.has(h.name)) why = `already held by ${held.get(h.name)}`;
      else if (this.blocked.has(claim)) why = 'it is an allocated app host';
      else if (this.known && isProtectedHostName(h.name) && !this.known.has(claim)) why = 'it is reserved for the OS';
      if (why) console.warn(`[AppRegistry] ${m.id}: ignoring host '${h.name}': ${why}`);
      return !why;
    });
    return kept.length === m.hosts.length ? m.hosts : kept;
  }
}
