// The D94 propagation API for the dependency-free side (the release builder,
// install.sh's runner, the updater container): the twin of
// packages/core/src/infra/propagate.ts (FROZEN signatures, Phase 6 Stage 1b;
// IC-5 implements both together), for code that runs before or outside a
// built core (core cannot be imported here). Same functions, same answers:
// packages/core/test/infra-propagate.test.mjs runs both on the same data roots.
//
//   renderDigest(dataDir)               `sha256:<hex>` of generated/current, or null without a config
//   infraExecEnv(consumer, { dataDir }) the non-secret env for a child process of that consumer
//   buildSecrets({ jobDir, dataDir, resolve | credentialsDir })
//                                       the secret files of one build (0400); dispose() removes them
//
// No rendered config: exactly today's behaviour (an empty env, no secrets: D94
// acceptance 6). A rendered dir that can't be read is refused
// (`infra-not-propagated`), never ignored. The kernel resolves `system:` refs
// itself (the sealed System Context); here a build passes its resolver, or the
// bootstrap credentials dir of an install.
import { chmodSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { refsOf } from './config.mjs';
import { BUILD_SECRET_IDS } from './adapters/index.mjs';
import { bootstrapResolver, renderBuildSecrets } from './secrets.mjs';
import { infraDir, readStore } from './store.mjs';

/** = infra/types.ts INFRA_CURRENT_LINK (render.mjs's `current` link under infraDir). */
export const INFRA_CURRENT_LINK = 'aura/infra/generated/current';

export class InfraPropagationError extends Error {
  constructor(message) { super(message); this.name = 'InfraPropagationError'; this.code = 'infra-not-propagated'; }
}
export class InfraCredentialError extends Error {
  constructor(message) { super(message); this.name = 'InfraCredentialError'; this.code = 'infra-credential-unresolved'; }
}

const dataRootOf = (dataDir) => dataDir ?? process.env.AURA_DATA_DIR ?? '/data';

export function renderDigest(dataDir) {
  try {
    const name = readlinkSync(join(dataRootOf(dataDir), INFRA_CURRENT_LINK));
    return /^[0-9a-f]{64}$/.test(name) ? `sha256:${name}` : null;
  } catch {
    return null;
  }
}

/** The rendered manifest, or null without a config; throws `infra-not-propagated` when unreadable. */
export function readInfraManifest(dataDir) {
  const d = renderDigest(dataDir);
  if (!d) return null;
  const sub = `aura/infra/generated/${d.slice(7)}`;
  try {
    const m = JSON.parse(readFileSync(join(dataRootOf(dataDir), sub, 'manifest.json'), 'utf8'));
    if (m.v !== 1 || !m.env || typeof m.env !== 'object') throw new Error('unknown manifest version');
    return m;
  } catch (e) {
    throw new InfraPropagationError(`the rendered infrastructure config (${sub}) can't be read: ${e.message}`);
  }
}

export function infraExecEnv(consumer, opts = {}) {
  const m = readInfraManifest(opts.dataDir);
  if (!m) return {};
  if ((consumer === 'app' || consumer === 'sidecar') && opts.inherit === 'none') return {};
  const env = { ...m.env };
  const extra = opts.noProxyExtra ?? [];
  for (const k of ['NO_PROXY', 'no_proxy']) {
    if (env[k] === undefined || !extra.length) continue;
    env[k] = [...new Set([...env[k].split(',').filter(Boolean), ...extra])].join(',');
  }
  return Object.freeze(env);
}

export async function buildSecrets(opts) {
  if (renderDigest(opts.dataDir) === null) return { secrets: {}, dispose: async () => undefined };
  const store = readStore(infraDir(dataRootOf(opts.dataDir)));
  if (!store) throw new InfraPropagationError('a rendered infrastructure config exists without its config.yaml');
  const resolve = opts.resolve ?? bootstrapResolver(opts.credentialsDir);
  const refs = refsOf(store.config);
  const missing = refs.filter((r) => { try { return !resolve(r.ref); } catch { return true; } });
  if (missing.length) throw new InfraCredentialError(`credential ${missing.map((r) => `${r.ref} (${r.path})`).join(', ')} can't be resolved: the build would run without it`);
  const rendered = renderBuildSecrets(store.config, null, undefined, resolve);
  const dir = join(opts.jobDir, 'infra-secrets');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const secrets = {};
  for (const [id, content] of Object.entries(rendered)) {
    if (!BUILD_SECRET_IDS.includes(id)) continue;
    const f = join(dir, id);
    writeFileSync(f, content, { mode: 0o400 });
    chmodSync(f, 0o400);
    secrets[id] = f;
  }
  return { secrets, dispose: async () => { rmSync(dir, { recursive: true, force: true }); } };
}
