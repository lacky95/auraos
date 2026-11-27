/**
 * The D64 `infra-*` switches (IC-6) as one typed view, the public-fallback refusal every
 * AuraOS-run download goes through, and the O2 first-boot seed: the install config's
 * `policy:` block is written once into the sealed security policy (host operator, audited) and
 * removed from the config, so the D64 record is the only truth afterwards.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INFRA_INHERIT, INFRA_PROXY, INFRA_PUBLIC_FALLBACK, INFRA_PUBLIC_ROOTS, resolveSecurityOptions, type SecurityPolicy,
} from '../security/options.js';
import { getAuthServices } from '../auth/services.js';
import { loadOsInfra } from './osInfra.js';
import { dataRootOf, readInfraManifest, renderedSubpath } from './propagate.js';
import type { InfraSpawnView } from './types.js';

export interface InfraPolicy {
  publicFallback: 'allow' | 'deny';
  proxy: 'off' | 'configured';
  inherit: 'defaults' | 'none';
  publicRoots: 'keep' | 'replace';
}

export const DEFAULT_INFRA_POLICY: Readonly<InfraPolicy> = Object.freeze({ publicFallback: 'allow', proxy: 'off', inherit: 'defaults', publicRoots: 'keep' });

/** The effective `infra-*` values of a stored security policy (a host env never sets these). */
export function infraPolicyOf(policy: SecurityPolicy): InfraPolicy {
  const v = new Map(resolveSecurityOptions(policy, {}).map((o) => [o.id, o.value]));
  return {
    publicFallback: v.get(INFRA_PUBLIC_FALLBACK) === 'deny' ? 'deny' : 'allow',
    proxy: v.get(INFRA_PROXY) === 'configured' ? 'configured' : 'off',
    inherit: v.get(INFRA_INHERIT) === 'none' ? 'none' : 'defaults',
    publicRoots: v.get(INFRA_PUBLIC_ROOTS) === 'replace' ? 'replace' : 'keep',
  };
}

/** The running system's `infra-*` values; the defaults before the kernel is up. */
export async function readInfraPolicy(): Promise<InfraPolicy> {
  let store: ReturnType<typeof getAuthServices>['securityPolicy'];
  try { store = getAuthServices().securityPolicy; } catch { return { ...DEFAULT_INFRA_POLICY }; }
  return infraPolicyOf(await store.get());
}

export class InfraPublicFallbackError extends Error {
  readonly code = 'infra-public-fallback-denied';
  constructor(message: string) { super(message); this.name = 'InfraPublicFallbackError'; }
}

/** Refuses a public endpoint under `infra-public-fallback=deny` (the message names what and how to fix it). */
export function refusePublic(policy: Pick<InfraPolicy, 'publicFallback'>, what: string, url: string, fix: string): void {
  if (policy.publicFallback !== 'deny') return;
  let host = url;
  try { host = new URL(url).host; } catch { /* not a URL: name it as given */ }
  throw new InfraPublicFallbackError(`${what}: ${host} is a public endpoint and infra-public-fallback is deny; ${fix}`);
}

/**
 * A download URL through `registries.artifacts.rewrites` (the rendered `artifacts.rewrites`,
 * longest prefix first, the same rule as os/infra/config.mjs rewriteUrl).
 */
export function artifactUrl(url: string, dataDir?: string): { url: string; rewritten: boolean } {
  const sub = renderedSubpath(dataDir);
  if (!sub) return { url, rewritten: false };
  let table = '';
  try { table = readFileSync(join(dataRootOf(dataDir), sub, 'artifacts.rewrites'), 'utf8'); } catch { return { url, rewritten: false }; }
  for (const line of table.split('\n')) {
    const [from, to] = line.split('\t');
    if (from && to && url.startsWith(from)) return { url: to + url.slice(from.length), rewritten: true };
  }
  return { url, rewritten: false };
}

/**
 * An AuraOS-run download from a public default: rewritten through the config's artifact mirrors,
 * refused under deny when no mirror covers it. One rule for the cap installer and the updater.
 * `infra-public-fallback` governs what an infrastructure config does not cover: with no config
 * nothing is rewritten or refused (D94 acceptance 6).
 */
export async function infraDownloadUrl(url: string, what: string, opts: { dataDir?: string; policy?: InfraPolicy } = {}): Promise<string> {
  // No config: today's behaviour (the switch governs what a config does not cover).
  if (renderedSubpath(opts.dataDir) === null) return url;
  const r = artifactUrl(url, opts.dataDir);
  if (!r.rewritten) refusePublic(opts.policy ?? await readInfraPolicy(), what, url, 'add a registries.artifacts.rewrites prefix for it in the infrastructure config');
  return r.url;
}

export interface InfraSeedDeps {
  securityPolicy: { set(id: string, raw: unknown): Promise<unknown> };
  audit: { record(e: { by: { kind: 'operator' }; action: string; target?: string; outcome?: 'ok' | 'failed'; detail?: Record<string, unknown> }): Promise<unknown> };
}

/**
 * O2: the config's `policy:` block becomes the D64 values once (host operator, install seed),
 * then leaves the config. Returns the option ids written.
 */
export async function seedInfraPolicy(dataDir: string, deps: InfraSeedDeps): Promise<string[]> {
  const osi = await loadOsInfra();
  const dir = osi.store.infraDir(dataRootOf(dataDir));
  const store = osi.store.readStore(dir);
  const seed = store?.config?.policy as { publicFallback?: string; proxy?: string } | undefined;
  if (!store || !seed) return [];
  const written: string[] = [];
  for (const [id, value] of [[INFRA_PUBLIC_FALLBACK, seed.publicFallback], [INFRA_PROXY, seed.proxy]] as const) {
    if (value === undefined) continue;
    await deps.securityPolicy.set(id, value);
    written.push(id);
  }
  const { policy: _seeded, ...rest } = store.config as Record<string, unknown>;
  osi.store.writeStore(dir, { text: osi.store.STORE_HEADER + osi.config.toYaml(rest), files: store.files, digest: store.digest });
  await deps.audit.record({
    by: { kind: 'operator' }, action: 'infra.policy-seeded', target: 'user:policy:security', outcome: 'ok',
    detail: { options: Object.fromEntries(written.map((id) => [id, id === INFRA_PUBLIC_FALLBACK ? seed.publicFallback : seed.proxy])), source: 'install seed' },
  });
  return written;
}

/**
 * What a workload start gets (`SpawnContext.infra`, D94 §5.3): the rendered config when
 * `infra-inherit` is `defaults`, nothing otherwise. Throws when a rendered config can't be read
 * (the start fails closed rather than running without the configured proxy and CA).
 */
export async function infraSpawnView(dataDir?: string, policy?: Pick<InfraPolicy, 'inherit'>): Promise<InfraSpawnView | null> {
  const m = readInfraManifest(dataDir);
  if (!m) return null;
  if ((policy ?? await readInfraPolicy()).inherit === 'none') return null;
  return { digest: m.digest, subpath: renderedSubpath(dataDir)!, env: { ...m.env } };
}
