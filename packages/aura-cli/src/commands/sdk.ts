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
 */
import type { Command } from 'commander';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, existsSync, statSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { color, fail, info, ok } from '../lib/format.js';

const DEFAULT_REGISTRY_URL = 'http://aura-com.aura.registry:4090';
const REGISTRY_HOST_DEFAULT = DEFAULT_REGISTRY_URL.replace(/^https?:\/\//, '');

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

/** Discover @aura/* deps from the cwd's package.json. Returns name+version
 *  pairs; version strings like "^0.0.1" → "0.0.1" (oras tag, exact). */
function discoverDeps(cwd: string): Array<{ fullName: string; basename: string; version: string }> {
  const path = join(cwd, 'package.json');
  if (!existsSync(path)) return [];
  let manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try { manifest = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return []; }
  const all = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
  const out: Array<{ fullName: string; basename: string; version: string }> = [];
  for (const [fullName, spec] of Object.entries(all)) {
    if (!fullName.startsWith('@aura/')) continue;
    // Skip workspace:* — those resolve via pnpm symlinks; if the user
    // landed here with workspace:* deps, they're in the wrong scope.
    if (typeof spec !== 'string' || spec === 'workspace:*' || spec.startsWith('workspace:')) continue;
    // ^0.0.1 / ~0.0.1 / 0.0.1 → 0.0.1. oras tags are exact.
    const version = spec.replace(/^[~^]/, '');
    const basename = fullName.replace(/^@aura\//, '');
    out.push({ fullName, basename, version });
  }
  return out;
}

/** Pull one @aura/<basename>:<version> tarball into a tmp dir, then
 *  extract its `package/` contents into <cwd>/node_modules/@aura/<basename>/.
 *  `oras pull` writes the .tgz at the tmp root; we untar it via tar(1). */
function installOne(
  cwd: string,
  registryHost: string,
  orasFlags: string[],
  pkg: { fullName: string; basename: string; version: string },
  quiet: boolean,
): boolean {
  const ref = `${registryHost}/aura/${pkg.basename}:${pkg.version}`;
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
    // 4. Move into node_modules/@aura/<name>/. Wipe any prior install.
    const dest = join(cwd, 'node_modules', '@aura', pkg.basename);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(pkgRoot, dest, { recursive: true });
    if (!quiet) console.log(`[sdk] ${pkg.fullName}@${pkg.version} → ${dest}`);
    return true;
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
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
