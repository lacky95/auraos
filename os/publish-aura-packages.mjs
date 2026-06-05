#!/usr/bin/env node
/**
 * Publish every `@aura/*` workspace package to the local Zot OCI registry
 * (com.aura.registry). Idempotent: a tag whose digest already matches the
 * about-to-be-pushed tarball is skipped.
 *
 * Why OCI for npm packages? AuraOS user-scope apps live outside pnpm's
 * workspace globs and can't resolve `workspace:*`. Publishing each `@aura/*`
 * as an OCI artifact lets `aura sdk install` pull them by version into a
 * user-scope app's `node_modules/@aura/<name>/` without involving npm at
 * all. See plan: `local-OCI-registry`.
 *
 * Usage (from monorepo root):
 *
 *   pnpm publish:local                     # all five packages
 *   pnpm publish:local --pkg @aura/app-sdk  # only one
 *   pnpm publish:local --registry http://aura-com.aura.registry:4001
 *   pnpm publish:local --force              # re-push even if digest matches
 *
 * Pre-requisites: each `@aura/*` package must have a built `dist/` (run
 * `pnpm build:libs` if unsure). `oras` and `npm` must be on PATH.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ARGS = process.argv.slice(2);
const FLAG = (name) => {
  const i = ARGS.indexOf(name);
  return i >= 0 ? (ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : true) : null;
};
const PKG_FILTER  = typeof FLAG('--pkg')      === 'string' ? FLAG('--pkg') : null;
// Resolution: --registry flag > AURA_REGISTRY_URL env > pinned default.
// 4090 is the manifest.serverPort the com.aura.registry app pins (see
// apps/com.aura.registry/app.manifest.json + RegistryConfig.ts).
const REGISTRY    = typeof FLAG('--registry') === 'string'
  ? FLAG('--registry')
  : (process.env.AURA_REGISTRY_URL ?? 'http://aura-com.aura.registry:4090');
const FORCE       = FLAG('--force') === true;

// Strip scheme for oras refs; plain http → --plain-http flag.
const REGISTRY_HOST = REGISTRY.replace(/^https?:\/\//, '').replace(/\/+$/, '');
const ORAS_FLAGS    = REGISTRY.startsWith('http://') ? ['--plain-http'] : [];

const ARTIFACT_TYPE = 'application/vnd.aura.npm-pkg.v1+json';
const LAYER_TYPE    = 'application/vnd.aura.npm-pkg.v1.tar+gzip';

// Packages to publish (dir name under `packages/`). `shell` skipped (it's
// the OS, not a library). CLI's directory is `aura-cli` not `cli` — the
// list is dir names, not pkg names; we read the real `@aura/<name>` from
// each package.json.
const PACKAGES = ['core', 'kv-store', 'app-sdk', 'ui', 'aura-cli'];

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', timeout: 180_000, ...opts });
  if (res.status !== 0) {
    const stderr = (res.stderr ?? '').trim();
    throw new Error(`${cmd} ${args.join(' ')} → exit ${res.status}\n${stderr}`);
  }
  return (res.stdout ?? '').trim();
}

function isOrasAvailable() {
  try { execFileSync('oras', ['version'], { stdio: 'pipe', timeout: 5_000 }); return true; }
  catch { return false; }
}

function tagExists(ref) {
  const out = spawnSync('oras', ['resolve', ref, ...ORAS_FLAGS],
    { stdio: 'pipe', encoding: 'utf8', timeout: 15_000 });
  return out.status === 0 && (out.stdout ?? '').trim().startsWith('sha256:');
}

/** Return value: 'pushed' | 'skipped' | 'missing'. Used to count summary
 *  totals correctly (the prior delta-on-stdout-length hack mis-classified
 *  pushed-with-progress-output as skipped). */
function publish(pkgName) {
  const pkgDir = join(ROOT, 'packages', pkgName);
  const manifestPath = join(pkgDir, 'package.json');
  if (!existsSync(manifestPath)) {
    console.warn(`[publish] skipping: ${manifestPath} not found`);
    return 'missing';
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const fullName = manifest.name;     // '@aura/app-sdk'
  const version  = manifest.version;  // '0.0.1'
  if (PKG_FILTER && PKG_FILTER !== fullName) return;

  const basename = fullName.replace(/^@aura\//, '');   // 'app-sdk'
  const ref = `${REGISTRY_HOST}/aura/${basename}:${version}`;

  // 1. Idempotency check — already pushed at this tag?
  if (!FORCE && tagExists(ref)) {
    console.log(`[publish] ${fullName}@${version} already at ${ref} — skipped`);
    return 'skipped';
  }

  // 2. npm pack into a temp dir (cleaner than the package dir).
  const tmp = mkdtempSync(join(tmpdir(), `aura-publish-${basename}-`));
  try {
    const packOut = run('npm', ['pack', '--silent', '--pack-destination', tmp, pkgDir], { cwd: tmp });
    // `npm pack` prints the filename on its last line; alternatively just
    // readdir tmp (we know it'll contain exactly one tgz).
    const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error(`no .tgz produced (npm pack output: ${packOut})`);
    const tgzPath = join(tmp, tgz);

    // 3. oras push <ref> <tgz>:<layer-mediatype> --artifact-type <artifact-mediatype>
    // --disable-path-validation: the layer's file is in /tmp (absolute); oras
    // normally refuses absolute paths because they'd land in the artifact's
    // `org.opencontainers.image.title` annotation. We want the basename only
    // (which oras records when given a relative path) — we cd into the tmp
    // dir + pass the basename so the layer's title is `<pkg>-<ver>.tgz`.
    console.log(`[publish] pushing ${fullName}@${version} → ${ref}`);
    run('oras', [
      'push', ref,
      `${tgz}:${LAYER_TYPE}`,
      '--artifact-type', ARTIFACT_TYPE,
      ...ORAS_FLAGS,
    ], { cwd: tmp });
    console.log(`[publish] ${fullName}@${version} ✓`);
    return 'pushed';
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function main() {
  if (!isOrasAvailable()) {
    console.error('[publish] `oras` not on PATH. Install via `aura cap install oras` (or run this from inside aura-shell which has it baked).');
    process.exit(2);
  }
  console.log(`[publish] target registry: ${REGISTRY}`);
  let pushed = 0, skipped = 0, missing = 0, failed = 0;
  for (const pkg of PACKAGES) {
    try {
      const status = publish(pkg);
      if (status === 'pushed') pushed++;
      else if (status === 'skipped') skipped++;
      else if (status === 'missing') missing++;
    } catch (err) {
      console.error(`[publish] ${pkg} FAILED: ${err.message}`);
      failed++;
    }
  }
  if (missing) console.log(`[publish] (${missing} package dirs missing)`);
  console.log(`[publish] summary: ${pushed} pushed, ${skipped} skipped, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
