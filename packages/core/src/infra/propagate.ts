/**
 * The D94 propagation API (frozen signatures: Phase 6 Stage 1b, 6B.0; implemented by IC-5).
 *
 * Every consumer that reaches the network (the release builder, the updater, the installer, the
 * cap installer, Nexus/oras, app and sidecar spawns, the Terminal session env) gets its
 * infrastructure settings through these functions, never by reading os/infra files itself:
 *
 *   renderDigest()          the digest of the rendered config (`sha256:<hex>`), or null without one
 *   infraExecEnv(consumer)  the non-secret env for a child process of that consumer
 *   buildSecrets(...)       the secret files of one build (BuildKit secret mounts), removed after it
 *
 * With no rendered config the answers are exactly today's behaviour (an empty env, no secrets:
 * D94 acceptance 6). The non-secret env is the render's own (`generated/current/manifest.json`,
 * os/infra/render.mjs): proxy URLs without credentials, the computed NO_PROXY, CA and config
 * pointers under /etc/aura/infra. A rendered dir that can't be read is refused
 * (`infra-not-propagated`), never ignored: a build or a spawn without the configured
 * proxy/CA/registry would silently go public.
 */
import { chmodSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILD_SECRET_IDS, INFRA_CURRENT_LINK, INFRA_GENERATED_DIR,
  type BuildSecretId, type BuildSecrets, type InfraConsumer, type InfraRenderManifest,
} from './types.js';
import { loadOsInfra } from './osInfra.js';
import { credentialResolver, type InfraCredential } from './credentials.js';

export class InfraPropagationError extends Error {
  readonly code = 'infra-not-propagated';
  constructor(message: string) { super(message); this.name = 'InfraPropagationError'; }
}

export const dataRootOf = (dataDir?: string): string => dataDir ?? process.env['AURA_DATA_DIR'] ?? '/data';

/** The digest of the rendered infrastructure config (`generated/current`), or null when none is configured. */
export function renderDigest(dataDir?: string): string | null {
  try {
    const name = readlinkSync(join(dataRootOf(dataDir), INFRA_CURRENT_LINK));
    return /^[0-9a-f]{64}$/.test(name) ? `sha256:${name}` : null;
  } catch {
    return null;
  }
}

/** The rendered dir of the current digest, relative to the data root (a volume subpath), or null. */
export function renderedSubpath(dataDir?: string): string | null {
  const d = renderDigest(dataDir);
  return d ? `${INFRA_GENERATED_DIR}/${d.slice('sha256:'.length)}` : null;
}

/** The rendered manifest, or null without a config; throws `infra-not-propagated` when it can't be read. */
export function readInfraManifest(dataDir?: string): InfraRenderManifest | null {
  const sub = renderedSubpath(dataDir);
  if (!sub) return null;
  try {
    const m = JSON.parse(readFileSync(join(dataRootOf(dataDir), sub, 'manifest.json'), 'utf8')) as InfraRenderManifest;
    if (m.v !== 1 || !m.env || typeof m.env !== 'object') throw new Error('unknown manifest version');
    return m;
  } catch (err) {
    throw new InfraPropagationError(`the rendered infrastructure config (${sub}) can't be read: ${(err as Error).message}`);
  }
}

/** `NO_PROXY`/`no_proxy` with runtime-known internal names appended (D94 §5.4). */
export function withNoProxy(env: Record<string, string>, extra: readonly string[]): Record<string, string> {
  if (!extra.length) return env;
  const out = { ...env };
  for (const k of ['NO_PROXY', 'no_proxy']) {
    if (out[k] === undefined) continue;
    const have = out[k]!.split(',').filter(Boolean);
    out[k] = [...new Set([...have, ...extra])].join(',');
  }
  return out;
}

export interface InfraExecEnvOptions {
  dataDir?: string;
  /** D64 `infra-inherit` for `app`/`sidecar`: `none` gives them nothing (the caller reads the option). */
  inherit?: 'defaults' | 'none';
  /** Internal destinations only the caller knows (an app's own container and sidecars, the local registry). */
  noProxyExtra?: readonly string[];
}

/** The non-secret infrastructure env for a child process of `consumer` (never a credential). */
export function infraExecEnv(consumer: InfraConsumer, opts: InfraExecEnvOptions = {}): Readonly<Record<string, string>> {
  const m = readInfraManifest(opts.dataDir);
  if (!m) return {};
  if ((consumer === 'app' || consumer === 'sidecar') && opts.inherit === 'none') return {};
  return Object.freeze(withNoProxy(m.env, opts.noProxyExtra ?? []));
}

export class InfraCredentialError extends Error {
  readonly code = 'infra-credential-unresolved';
  constructor(message: string) { super(message); this.name = 'InfraCredentialError'; }
}

/**
 * The secret files of one build under `jobDir` (0400, the job's own directory), for BuildKit
 * `--secret id=…,src=…` and the throwaway build container; the caller disposes them in a `finally`.
 * Every credential the config references must resolve (system: refs from the sealed System
 * Context, bound to their hosts; bootstrap: refs not imported yet): a build never runs with part
 * of its credentials missing.
 */
export async function buildSecrets(opts: {
  jobDir: string;
  dataDir?: string;
  /** Tests and the installer: a resolver instead of the System Context. */
  resolve?: (ref: string) => InfraCredential | null;
}): Promise<BuildSecrets> {
  if (renderDigest(opts.dataDir) === null) return { secrets: {}, dispose: async () => undefined };
  const osi = await loadOsInfra();
  const store = osi.store.readStore(osi.store.infraDir(dataRootOf(opts.dataDir)));
  if (!store) throw new InfraPropagationError('a rendered infrastructure config exists without its config.yaml: run `aura admin infra doctor`');
  const refs = osi.config.refsOf(store.config) as Array<{ ref: string; path: string; hosts: string[] }>;
  const resolve = opts.resolve ?? await credentialResolver({ dataDir: dataRootOf(opts.dataDir), refs });
  const missing = refs.filter((r) => !resolve(r.ref));
  if (missing.length) {
    throw new InfraCredentialError(`credential ${missing.map((r) => `${r.ref} (${r.path})`).join(', ')} can't be resolved: the build would run without it`);
  }
  const rendered = osi.secrets.renderBuildSecrets(store.config, null, undefined, resolve) as Record<string, string>;
  const dir = join(opts.jobDir, 'infra-secrets');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const secrets: Partial<Record<BuildSecretId, string>> = {};
  try {
    for (const [id, content] of Object.entries(rendered)) {
      if (!(BUILD_SECRET_IDS as readonly string[]).includes(id)) continue;
      const f = join(dir, id);
      writeFileSync(f, content, { mode: 0o400 });
      chmodSync(f, 0o400);
      secrets[id as BuildSecretId] = f;
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { secrets, dispose: async () => { rmSync(dir, { recursive: true, force: true }); } };
}
