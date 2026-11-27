/**
 * The D94 inputs of one release build (os/release/builder.mjs `--infra FILE`, `BuildInfraInputs`),
 * prepared by the kernel for the updater's detached build container (SelfUpdater.startBuild): the
 * non-secret env, the build args (the Docker Hub mirror prefix), the rendered dir as the named
 * build context, the corporate CA and the git config, and the BuildKit secret files of this build
 * (buildSecrets: every credential resolved, 0400) under `/data/aura/infra/run/<runId>/` (0700).
 * The build's script removes that dir when it ends; a leftover is swept at boot. No config: null
 * (the builder runs exactly as today).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { BuildInfraInputs } from './types.js';
import { INFRA_DIR } from './types.js';
import { buildSecrets, dataRootOf, infraExecEnv, readInfraManifest, renderedSubpath } from './propagate.js';
import type { InfraCredential } from './credentials.js';

export const INFRA_RUN_DIR = `${INFRA_DIR}/run`;
/** A run dir older than this is a crashed build's: swept at boot. */
export const INFRA_RUN_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export async function releaseBuildInfra(o: {
  runId: string; dataDir?: string; resolve?: (ref: string) => InfraCredential | null;
}): Promise<{ file: string; dir: string; inputs: BuildInfraInputs } | null> {
  const root = dataRootOf(o.dataDir);
  const m = readInfraManifest(o.dataDir);
  if (!m) return null;
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(o.runId)) throw new Error(`invalid build run id: ${o.runId}`);
  const dir = join(root, INFRA_RUN_DIR, o.runId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  try {
    const s = await buildSecrets({ jobDir: dir, ...(o.dataDir ? { dataDir: o.dataDir } : {}), ...(o.resolve ? { resolve: o.resolve } : {}) });
    const rendered = join(root, renderedSubpath(o.dataDir)!);
    const has = (f: string) => existsSync(join(rendered, f)) && readFileSync(join(rendered, f), 'utf8').trim() !== '';
    const docker = (() => {
      try { return readFileSync(join(rendered, 'oci', 'mirrors'), 'utf8').split('\n').map((l) => l.split('\t')).find(([k]) => k === 'docker.io')?.[1] ?? null; } catch { return null; }
    })();
    const inputs: BuildInfraInputs = {
      digest: m.digest,
      buildArgs: docker ? { DOCKER_IO_REGISTRY: docker.replace(/\/+$/, '') } : {},
      env: { ...infraExecEnv('release-build', o.dataDir ? { dataDir: o.dataDir } : {}) },
      secrets: s.secrets,
      publicContext: rendered,
      caBundle: has('corporate-ca.pem') ? join(rendered, 'corporate-ca.pem') : null,
      gitConfig: has('gitconfig') ? join(rendered, 'gitconfig') : null,
    };
    const file = join(dir, 'inputs.json');
    writeFileSync(file, `${JSON.stringify({ v: 1, ...inputs }, null, 2)}\n`, { mode: 0o600 });
    return { file, dir, inputs };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Boot: remove run dirs of builds that can't still be running (older than INFRA_RUN_MAX_AGE_MS). */
export function sweepInfraRuns(dataDir?: string, now = Date.now()): number {
  const base = join(dataRootOf(dataDir), INFRA_RUN_DIR);
  let n = 0;
  let entries: string[] = [];
  try { entries = readdirSync(base); } catch { return 0; }
  for (const e of entries) {
    try {
      if (now - statSync(join(base, e)).mtimeMs < INFRA_RUN_MAX_AGE_MS) continue;
      rmSync(join(base, e), { recursive: true, force: true });
      n++;
    } catch { /* gone */ }
  }
  return n;
}
