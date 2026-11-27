/**
 * `aura sdk install` — pull every @aura/* dep declared in the cwd's
 * package.json from the local OCI registry and extract into
 * `node_modules/@aura/<name>/`.
 *
 * Why this exists: user-scope apps live outside the pnpm workspace, so
 * `workspace:*` symlinks aren't an option AND plain `npm install`
 * doesn't know how to resolve a package whose source-of-truth is an OCI
 * artifact, not an npm registry. This command speaks OCI Distribution
 * directly via `oras` — same plumbing Nexus uses for app installs.
 *
 * Typical invocation (from inside a user-scope app's sandbox):
 *
 *   aura sdk install                              # auto-discover deps
 *   aura sdk install --quiet                      # only log failures
 *   aura sdk install --registry http://other:4090 # override target
 *
 * Wired into the synth entrypoint (ContainerRunner + ProotRunner) so
 * apps boot from scratch without a manual step.
 *
 * The version tag never changes in this monorepo (0.0.1), so an installed copy
 * records the digest of the layer it came from (DIGEST_FILE) and is replaced
 * only when the registry holds a different one. With the registry unreachable
 * an installed copy stays as it is, and a directory that is not one of our
 * copies (a symlink, another package) is never replaced.
 */
import type { Command } from 'commander';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, existsSync, statSync, lstatSync, cpSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { color, fail, info, ok } from '../lib/format.js';

const DEFAULT_REGISTRY_URL = 'http://aura-com.aura.registry:4090';
const REGISTRY_HOST_DEFAULT = DEFAULT_REGISTRY_URL.replace(/^https?:\/\//, '');
/** In an installed package: the registry layer digest it was unpacked from. */
export const DIGEST_FILE = '.aura-oci-digest';

interface InstallOpts {
  registry?: string;
  quiet?:    boolean;
  cwd?:      string;
}

function pickRegistry(opts: InstallOpts): string {
  return opts.registry ?? process.env['AURA_REGISTRY_URL'] ?? DEFAULT_REGISTRY_URL;
}

function isOrasAvailable(): boolean {
  try { execFileSync('oras', ['version'], { stdio: 'pipe', timeout: 5_000 }); return true; }
  catch { return false; }
}

/** An @aura/* entry `aura sdk install` accepts (the name becomes a path, both a registry ref). */
const AURA_DEP_NAME = /^@aura\/[a-z0-9][a-z0-9._-]*$/;
const AURA_DEP_VERSION = /^[~^]?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Discover @aura/* deps from the cwd's package.json. Reads two fields:
 *
 *   • `auraDependencies` — preferred for user/global-scope apps. npm/pnpm
 *     ignore unknown fields, so listing @aura/* here lets `npm install`
 *     succeed for the rest of the tree without choking on a spec it can't
 *     resolve from the (OCI-only) local registry.
 *
 *   • `dependencies` + `devDependencies` — legacy / system-scope. We still
 *     scan these for @aura/* entries so apps that opted into the previous
 *     "@aura/foo in dependencies" shape keep working.
 *
 *   workspace:* entries are skipped — those resolve via pnpm symlinks
 *   (system-scope path), not OCI. Version specs are stripped to exact tags
 *   ("^0.0.1" → "0.0.1") because oras refs are exact. */
function discoverDeps(cwd: string): Array<{ fullName: string; basename: string; version: string }> {
  const path = join(cwd, 'package.json');
  if (!existsSync(path)) return [];
  let manifest: {
    dependencies?:      Record<string, string>;
    devDependencies?:   Record<string, string>;
    auraDependencies?:  Record<string, string>;
  };
  try { manifest = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return []; }
  const merged: Record<string, string> = {
    ...(manifest.dependencies     ?? {}),
    ...(manifest.devDependencies  ?? {}),
    ...(manifest.auraDependencies ?? {}),  // takes precedence on duplicates
  };
  const out: Array<{ fullName: string; basename: string; version: string }> = [];
  for (const [fullName, spec] of Object.entries(merged)) {
    if (!fullName.startsWith('@aura/')) continue;
    if (typeof spec !== 'string' || spec === 'workspace:*' || spec.startsWith('workspace:')) continue;
    // Anything else could name a path outside node_modules/@aura (as a scaffold refuses it).
    if (!AURA_DEP_NAME.test(fullName) || !AURA_DEP_VERSION.test(spec)) {
      console.error(color.yellow(`[sdk] ${JSON.stringify(fullName).slice(0, 80)}: not an @aura/<name>: x.y.z entry — skipped`));
      continue;
    }
    const version = spec.replace(/^[~^]/, '');
    const basename = fullName.replace(/^@aura\//, '');
    out.push({ fullName, basename, version });
  }
  return out;
}

/** Digest of the tarball layer at `ref`, or null when it can't be read. */
function remoteDigest(ref: string, orasFlags: string[]): string | null {
  const out = spawnSync('oras', ['manifest', 'fetch', ref, ...orasFlags], { encoding: 'utf8', timeout: 15_000 });
  if (out.status !== 0) return null;
  try {
    const digest = (JSON.parse(out.stdout) as { layers?: Array<{ digest?: unknown }> }).layers?.[0]?.digest;
    return typeof digest === 'string' ? digest : null;
  } catch { return null; }
}

/** Is `dest` a copy this command installed (now, or before digests were recorded)? */
function isInstalledCopy(dest: string, fullName: string): boolean {
  try {
    if (!lstatSync(dest).isDirectory()) return false;
    if (existsSync(join(dest, DIGEST_FILE))) return true;
    return (JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')) as { name?: string }).name === fullName;
  } catch { return false; }
}

/** Pull one @aura/<basename>:<version> tarball into a tmp dir, then
 *  extract its `package/` contents into <cwd>/node_modules/@aura/<basename>/,
 *  unless the installed copy already holds that digest.
 *  `oras pull` writes the .tgz at the tmp root; we untar it via tar(1). */
export function installOne(
  cwd: string,
  registryHost: string,
  orasFlags: string[],
  pkg: { fullName: string; basename: string; version: string },
  quiet: boolean,
): boolean {
  const ref = `${registryHost}/aura/${pkg.basename}:${pkg.version}`;
  const dest = join(cwd, 'node_modules', '@aura', pkg.basename);
  const present = lstatExists(dest);
  if (present && !isInstalledCopy(dest, pkg.fullName)) {
    console.error(color.yellow(`[sdk] ${pkg.fullName}: ${dest} is not an installed copy — left as it is`));
    return true;
  }
  const digest = remoteDigest(ref, orasFlags);
  if (present && !digest) {
    if (!quiet) console.error(color.yellow(`[sdk] ${pkg.fullName}: registry unavailable — keeping the installed copy`));
    return true;
  }
  if (present && digest && readDigest(dest) === digest) {
    if (!quiet) console.log(`[sdk] ${pkg.fullName}@${pkg.version} up to date`);
    return true;
  }
  const tmp = mkdtempSync(join(tmpdir(), `aura-sdk-${pkg.basename}-`));
  try {
    // 1. Pull the artifact. Layer is a single .tgz.
    const pull = spawnSync('oras', ['pull', ref, '-o', tmp, ...orasFlags],
      { encoding: 'utf8', timeout: 120_000 });
    if (pull.status !== 0) {
      if (!quiet) console.error(color.red(`[sdk] pull ${ref} failed: ${(pull.stderr ?? '').slice(0, 200)}`));
      return false;
    }
    // 2. Find the .tgz oras dropped.
    const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!tgz) {
      if (!quiet) console.error(color.red(`[sdk] ${pkg.fullName}: no .tgz in pulled artifact`));
      return false;
    }
    if (digest) {
      const pulled = `sha256:${createHash('sha256').update(readFileSync(join(tmp, tgz))).digest('hex')}`;
      if (pulled !== digest) {
        if (!quiet) console.error(color.red(`[sdk] ${pkg.fullName}: pulled tarball does not match ${digest}`));
        return false;
      }
    }
    // 3. Extract into a staging dir. npm pack tarballs always wrap content
    //    under a top-level `package/` directory.
    const stage = join(tmp, 'unpacked');
    mkdirSync(stage, { recursive: true });
    const untar = spawnSync('tar', ['-xzf', join(tmp, tgz), '-C', stage],
      { encoding: 'utf8', timeout: 60_000 });
    if (untar.status !== 0) {
      if (!quiet) console.error(color.red(`[sdk] ${pkg.fullName}: untar failed: ${(untar.stderr ?? '').slice(0, 200)}`));
      return false;
    }
    const pkgRoot = join(stage, 'package');
    if (!existsSync(pkgRoot) || !statSync(pkgRoot).isDirectory()) {
      if (!quiet) console.error(color.red(`[sdk] ${pkg.fullName}: tarball missing top-level package/ dir`));
      return false;
    }
    if (digest) writeFileSync(join(pkgRoot, DIGEST_FILE), `${digest}\n`);
    // 4. Swap into node_modules/@aura/<name>/. Copied next to it first, so a
    //    failure here leaves the installed copy in place.
    const next = join(cwd, 'node_modules', '@aura', `.${pkg.basename}.next`);
    const old  = join(cwd, 'node_modules', '@aura', `.${pkg.basename}.old`);
    rmSync(next, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
    mkdirSync(next, { recursive: true });
    cpSync(pkgRoot, next, { recursive: true });
    if (present) renameSync(dest, old);
    renameSync(next, dest);
    rmSync(old, { recursive: true, force: true });
    if (!quiet) console.log(`[sdk] ${pkg.fullName}@${pkg.version} → ${dest}`);
    return true;
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function readDigest(dest: string): string | null {
  try { return readFileSync(join(dest, DIGEST_FILE), 'utf8').trim() || null; } catch { return null; }
}

async function runInstall(opts: InstallOpts): Promise<void> {
  const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();
  if (!isOrasAvailable()) {
    fail('`oras` not on PATH. Add `oras` to this app\'s manifest tools[] (or `*` for all).');
  }
  const registry = pickRegistry(opts);
  const registryHost = registry.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const orasFlags = registry.startsWith('http://') ? ['--plain-http'] : [];
  const deps = discoverDeps(cwd);
  if (deps.length === 0) {
    if (!opts.quiet) info('No @aura/* deps in package.json — nothing to install.');
    return;
  }
  if (!opts.quiet) info(`Installing ${deps.length} @aura/* deps from ${registry}`);
  let okCount = 0;
  let failCount = 0;
  for (const d of deps) {
    if (installOne(cwd, registryHost, orasFlags, d, !!opts.quiet)) okCount++;
    else failCount++;
  }
  if (failCount > 0) {
    fail(`${failCount} of ${deps.length} @aura/* installs failed (${okCount} ok)`);
  }
  if (!opts.quiet) ok(`${okCount} @aura/* package(s) installed`);
}

export function registerSdk(program: Command): void {
  const sdk = program
    .command('sdk')
    .description('Install / inspect @aura/* SDK packages pulled from the local OCI registry.');

  sdk
    .command('install')
    .description("Pull every @aura/* dep declared in the cwd's package.json into node_modules/.")
    .option('--registry <url>', 'Override target registry URL (default: env AURA_REGISTRY_URL → local)')
    .option('--quiet',          'Suppress per-package logs; only print failures')
    .option('--cwd <path>',     'Run from this directory instead of process.cwd()')
    .action(async (opts: InstallOpts) => {
      await runInstall(opts);
    });
}
