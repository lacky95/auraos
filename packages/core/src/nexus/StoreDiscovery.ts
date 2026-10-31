/**
 * "Add a store by its address" — the flatpak-remote-add way.
 *
 * A publisher puts one small file on their website:
 *
 *   https://apps.acme.com/.well-known/aura-store.json
 *   {
 *     "name":  "acme",                          // source name (suggested)
 *     "title": "ACME Apps",                     // shown to the customer
 *     "kind":  "oci",                           // today: oci only
 *     "url":   "https://registry.acme.com",     // the OCI registry
 *     "auth":  "basic"                          // or "none"
 *   }
 *
 * A customer types `apps.acme.com` (Nexus → Sources, or `aura nexus registry
 * add apps.acme.com`); AuraOS reads the file, fills in the source and only asks
 * for the username and password when `auth` is "basic".
 */

import { probeRegistryAddress } from './RegistryProbe.js';

export interface StoreDescriptor {
  name:  string;
  title?: string;
  kind:  'oci';
  url:   string;
  auth:  'basic' | 'none';
  appRepoPrefix?: string;
}

export class StoreDiscoveryError extends Error {
  constructor(message: string) { super(message); this.name = 'StoreDiscoveryError'; }
}

const MAX_BYTES = 16 * 1024;
const TIMEOUT_MS = 8_000;
const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/** `apps.acme.com` / `https://apps.acme.com/x` → `https://apps.acme.com/.well-known/aura-store.json`. */
export function wellKnownUrl(address: string): string {
  const raw = address.trim();
  if (!raw) throw new StoreDiscoveryError('enter the address of the store');
  let u: URL;
  try { u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { throw new StoreDiscoveryError(`'${address}' is not a web address`); }
  if (u.protocol !== 'https:') throw new StoreDiscoveryError('a store address must use https');
  return `https://${u.host}/.well-known/aura-store.json`;
}

/** Validate a descriptor. Throws StoreDiscoveryError with what is wrong. */
export function parseStoreDescriptor(json: unknown): StoreDescriptor {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new StoreDiscoveryError('aura-store.json is not a JSON object');
  const d = json as Record<string, unknown>;
  const name = typeof d['name'] === 'string' ? d['name'].trim().toLowerCase() : '';
  if (!NAME.test(name)) throw new StoreDiscoveryError('aura-store.json: "name" must be a short lowercase name (a-z, 0-9, . _ -)');
  const kind = d['kind'] ?? 'oci';
  if (kind !== 'oci') throw new StoreDiscoveryError(`aura-store.json: "kind" '${String(kind)}' is not supported (only "oci")`);
  const url = typeof d['url'] === 'string' ? d['url'].trim().replace(/\/+$/, '') : '';
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new StoreDiscoveryError('aura-store.json: "url" must be the registry address, e.g. https://registry.example.com'); }
  if (parsed.protocol !== 'https:') throw new StoreDiscoveryError('aura-store.json: the registry "url" must use https');
  if (parsed.username || parsed.password) throw new StoreDiscoveryError('aura-store.json: the registry "url" must not contain a login');
  const auth = d['auth'] ?? 'none';
  if (auth !== 'basic' && auth !== 'none') throw new StoreDiscoveryError('aura-store.json: "auth" must be "basic" or "none"');
  const out: StoreDescriptor = { name, kind: 'oci', url, auth };
  if (typeof d['title'] === 'string' && d['title'].trim()) out.title = d['title'].trim().slice(0, 100);
  if (typeof d['appRepoPrefix'] === 'string' && /^[a-z0-9][a-z0-9._/-]*$/.test(d['appRepoPrefix'])) out.appRepoPrefix = d['appRepoPrefix'];
  return out;
}

/** Fetch and validate a store's descriptor from its address. When the
 *  address has no `/.well-known/aura-store.json` but is itself an OCI
 *  registry (`registry.example.com/team/apps`), the address is the store:
 *  host = registry, path = app prefix (RegistryProbe). */
export async function discoverStore(address: string, fetchImpl: typeof fetch = fetch): Promise<StoreDescriptor> {
  const url = wellKnownUrl(address);
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow', headers: { accept: 'application/json' } });
  } catch (err) {
    throw new StoreDiscoveryError(`could not reach ${url}: ${(err as Error).message}`);
  }
  if (res.status === 404) {
    const reg = await registryStore(address, fetchImpl);
    if (reg) return reg;
    throw new StoreDiscoveryError(`${new URL(url).host} has no AuraOS store (no /.well-known/aura-store.json) and is no OCI registry — add it with the registry URL instead`);
  }
  if (!res.ok) throw new StoreDiscoveryError(`${url} answered HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new StoreDiscoveryError('aura-store.json is too large');
  let json: unknown;
  try { json = JSON.parse(text); } catch {
    const reg = await registryStore(address, fetchImpl);
    if (reg) return reg;
    throw new StoreDiscoveryError('aura-store.json is not valid JSON');
  }
  return parseStoreDescriptor(json);
}

/** The descriptor of an address that is an OCI registry, or null. */
async function registryStore(address: string, fetchImpl: typeof fetch): Promise<StoreDescriptor | null> {
  const reg = await probeRegistryAddress(address, fetchImpl);
  if (!reg) return null;
  // Suggested source name: the host without a leading `registry.` / `oci.`.
  const host = new URL(reg.url).host.toLowerCase();
  const suggested = host.replace(/^(registry|oci|cr|docker)\./, '').replace(/:\d+$/, '').slice(0, 63);
  return {
    name:  NAME.test(suggested) ? suggested : 'registry',
    title: reg.prefix ? `${host}/${reg.prefix}` : host,
    kind:  'oci',
    url:   reg.url,
    auth:  reg.needsLogin ? 'basic' : 'none',
    ...(reg.prefix ? { appRepoPrefix: reg.prefix } : {}),
  };
}
