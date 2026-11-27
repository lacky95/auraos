/**
 * Installing a new app's dependencies in the shell without root (AF1, owner
 * 2026-11-27: "Approval alone is not sufficient justification for running
 * untrusted package installation scripts as root. Ensure appropriate build
 * isolation and least privilege.").
 *
 * `/api/admin/scaffold` installs a user/global app's dependencies at create
 * time so its first start fits the health window. That install reads a
 * client-supplied package.json, so it runs:
 *   • as INSTALL_UID/GID (nobody), owning the app directory only while it
 *     runs: it can neither read root-only files (secrets, /root, the
 *     owner's home) nor write anything but the app, its own store and a
 *     throwaway HOME;
 *   • with a minimal environment (no shell secrets, tokens or context);
 *   • with SCAFFOLD_INSTALL_ARGS (no lifecycle scripts, no pnpmfile), after
 *     refusedScaffoldFiles has refused the files that could steer it.
 * pnpm comes from corepack's cache under root's home, which nobody cannot
 * read, so its package is copied once into a root-owned, world-readable
 * tools dir and run with node directly. Anything missing fails closed: the
 * install is reported as not done and the app's own sandbox installs at its
 * first start (the entrypoint fallback), never root.
 *
 * A store app's install (Nexus install, update, patch activation) goes the
 * same way (installStoreDepsUnprivileged): npm as INSTALL_UID, minimal env,
 * no lifecycle scripts, in a throwaway work dir that holds only the app's
 * package.json, package-lock.json and .npmrc (refusedStoreInstallFiles checked
 * them before the owner's approval). The install user never touches the app
 * dir: its tree carries runtime data (`.data`, `.sidecars`) with owners of
 * their own. The finished node_modules is moved in and handed to root. The
 * install scripts it skipped are the app's own sandbox's to run, at its first
 * start (provisioning.ts PENDING_BUILDS_FILE), never the shell's.
 *
 * Remaining for Phase 6 G: run it in a throwaway builder container (no
 * shell network namespace, no loopback services) instead of a uid drop.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chownSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCAFFOLD_INSTALL_ARGS } from '../scopes/scaffoldPayload.js';

/** nobody:nogroup. Owns nothing on the system besides what an install hands it. */
export const INSTALL_UID = 65534;
export const INSTALL_GID = 65534;

/** Environment names an unprivileged install inherits; everything else (secrets, tokens, context) is dropped. */
const INHERITED_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'AURA_REGISTRY_URL'];

export interface UnprivilegedInstallPaths {
  /** pnpm's content store and metadata cache for unprivileged installs (owned by INSTALL_UID). */
  storeDir: string;
  /** Root-owned copies of the package-manager code an unprivileged install runs. */
  toolsDir: string;
  /** Root-owned parent of the throwaway work dirs of store installs (each one handed to INSTALL_UID). */
  workDir?: string;
}

/** Default paths under the data dir. */
export function unprivilegedInstallPaths(dataDir = process.env['AURA_DATA_DIR'] ?? '/data'): UnprivilegedInstallPaths {
  return {
    storeDir: join(dataDir, 'aura', 'install-store'), toolsDir: join(dataDir, 'aura', 'install-tools'),
    workDir: join(dataDir, 'aura', 'install-work'),
  };
}

/** The environment of an unprivileged install: the inherited names, a throwaway HOME, scripts and pnpmfiles off. */
export function unprivilegedInstallEnv(env: NodeJS.ProcessEnv, home: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of INHERITED_ENV) { const v = env[k]; if (typeof v === 'string') out[k] = v; }
  Object.assign(out, {
    HOME: home,
    npm_config_ignore_scripts: 'true',
    npm_config_ignore_pnpmfile: 'true',
    npm_config_update_notifier: 'false',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  });
  return out;
}

export type InstallStep = { ok: boolean; error?: string };

/**
 * The pnpm entry point an unprivileged install runs: corepack's cached pnpm
 * package for `version`, copied once into `toolsDir`. Null when it cannot be
 * found (the caller fails closed).
 */
export function unprivilegedPnpm(toolsDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const v = spawnSync('pnpm', ['--version'], { cwd: tmpdir(), encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const version = (v.stdout ?? '').trim();
  if (v.status !== 0 || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  const copy = join(toolsDir, `pnpm-${version}`);
  const entry = join(copy, 'bin', 'pnpm.mjs');
  if (existsSync(entry)) return entry;
  const home = env['COREPACK_HOME'] ?? join(env['HOME'] ?? '/root', '.cache', 'node', 'corepack');
  const source = join(home, 'v1', 'pnpm', version);
  if (!existsSync(join(source, 'bin', 'pnpm.mjs'))) return null;
  const staging = `${copy}.tmp-${process.pid}`;
  try {
    mkdirSync(toolsDir, { recursive: true, mode: 0o755 });
    rmSync(staging, { recursive: true, force: true });
    cpSync(source, staging, { recursive: true });
    spawnSync('chmod', ['-R', 'u+rwX,go+rX,go-w', staging], { stdio: 'ignore', timeout: 60_000 });
    rmSync(copy, { recursive: true, force: true });
    spawnSync('mv', [staging, copy], { stdio: 'ignore', timeout: 60_000 });
  } catch {
    rmSync(staging, { recursive: true, force: true });
    return null;
  }
  return existsSync(entry) ? entry : null;
}

/** Hand `dir` (recursively, never following symlinks) to uid:gid. */
function own(dir: string, uid: number, gid: number): boolean {
  const r = spawnSync('chown', ['-R', '-h', `${uid}:${gid}`, dir], { stdio: 'ignore', timeout: 120_000 });
  return r.status === 0;
}

function describe(label: string, r: SpawnSyncReturns<string>): string {
  const out = [r.stderr, r.stdout].map((s) => (s ?? '').toString().trim()).filter(Boolean).join('\n');
  const detail = out || r.error?.message || `exited with ${r.signal ? `signal ${r.signal}` : `status ${r.status}`}`;
  return `${label}: ${detail}`.slice(0, 600);
}

/**
 * Install `dest`'s dependencies as INSTALL_UID: `pnpm install` (no scripts, no
 * pnpmfile), then `aura sdk install` (@aura/* from the local registry). `dest`
 * is handed back to root:root afterwards, whatever happened.
 */
export function installAppDepsUnprivileged(dest: string, opts: {
  paths?: UnprivilegedInstallPaths; env?: NodeJS.ProcessEnv; uid?: number; gid?: number;
  pnpmEntry?: string | null; spawn?: typeof spawnSync;
} = {}): InstallStep {
  const paths = opts.paths ?? unprivilegedInstallPaths();
  const env = opts.env ?? process.env;
  const uid = opts.uid ?? INSTALL_UID;
  const gid = opts.gid ?? INSTALL_GID;
  const run = opts.spawn ?? spawnSync;
  const pnpm = opts.pnpmEntry !== undefined ? opts.pnpmEntry : unprivilegedPnpm(paths.toolsDir, env);
  if (!pnpm) return { ok: false, error: 'pnpm is not available to an unprivileged install; the app installs its dependencies in its own sandbox at its first start' };
  let home: string | null = null;
  try {
    for (const d of [paths.storeDir, join(paths.storeDir, 'store'), join(paths.storeDir, 'cache')]) {
      mkdirSync(d, { recursive: true });
      chownSync(d, uid, gid);
    }
    home = mkdtempSync(join(tmpdir(), 'aura-install-'));
    chownSync(home, uid, gid);
    if (!own(dest, uid, gid)) return { ok: false, error: `could not hand ${dest} to the unprivileged install user` };
    const base = { cwd: dest, uid, gid, env: unprivilegedInstallEnv(env, home), encoding: 'utf-8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
    // Store and metadata cache as flags: pnpm >= 11 does not read them from npm_config_* (its own, shared by
    // every unprivileged install, so the second install of the same packages is offline).
    const storeArgs = [`--store-dir=${join(paths.storeDir, 'store')}`, `--cache-dir=${join(paths.storeDir, 'cache')}`];
    const install = run(process.execPath, [pnpm, ...SCAFFOLD_INSTALL_ARGS, ...storeArgs], { ...base, timeout: 180_000 }) as SpawnSyncReturns<string>;
    // Judge pnpm by its artifact, not its exit code: it exits non-zero on ignored
    // dependency builds although the install is complete.
    if (!existsSync(join(dest, 'node_modules', '.bin', 'astro'))) return { ok: false, error: describe('pnpm install', install) };
    const sdk = run('aura', ['sdk', 'install'], { ...base, timeout: 120_000 }) as SpawnSyncReturns<string>;
    if (sdk.status !== 0 || !existsSync(join(dest, 'node_modules', '@aura'))) return { ok: false, error: describe('aura sdk install', sdk) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `unprivileged install failed: ${(err as Error).message}` };
  } finally {
    own(dest, 0, 0);
    if (home) rmSync(home, { recursive: true, force: true });
  }
}

/** npm's flags for a store app's dependencies: never a lifecycle script. */
export const STORE_INSTALL_ARGS: readonly string[] = ['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund'];
/** The only files of a store app its shell-side install sees (refusedStoreInstallFiles checks them). */
const STORE_INSTALL_INPUTS = ['package.json', 'package-lock.json', '.npmrc'];

export interface StoreInstallOpts {
  /** Run npm (a fresh node_modules replaces the app's). */
  npm: boolean;
  /** Pull the @aura/* packages (`aura sdk install`). */
  sdk: boolean;
  onLine?: (line: string) => void;
  paths?: UnprivilegedInstallPaths;
  env?: NodeJS.ProcessEnv;
  /** The install identity. Default: INSTALL_UID/GID when the shell runs as root, else the shell's own (already unprivileged). */
  uid?: number;
  gid?: number;
}

export interface StoreInstallResult { ran: string[]; warnings: string[] }

/**
 * Install a store app's dependencies without root (see the header): the
 * steps run in a work dir as the install user, then node_modules (or, for
 * `sdk` alone, node_modules/@aura) moves into `appDir` and is handed to root.
 * A failed npm install throws (nothing is moved; the app's sandbox installs at
 * its first start); a failed `aura sdk install` is a warning.
 */
export async function installStoreDepsUnprivileged(appDir: string, o: StoreInstallOpts): Promise<StoreInstallResult> {
  const result: StoreInstallResult = { ran: [], warnings: [] };
  const paths = o.paths ?? unprivilegedInstallPaths();
  const isRoot = process.getuid?.() === 0;
  const uid = o.uid ?? (isRoot ? INSTALL_UID : process.getuid?.() ?? INSTALL_UID);
  const gid = o.gid ?? (isRoot ? INSTALL_GID : process.getgid?.() ?? INSTALL_GID);
  const handTo = (p: string) => { if (isRoot) chownSync(p, uid, gid); };
  const cache = join(paths.storeDir, 'npm-cache');
  for (const d of [paths.storeDir, cache]) { mkdirSync(d, { recursive: true }); handTo(d); }
  const workRoot = paths.workDir ?? join(paths.storeDir, '..', 'install-work');
  mkdirSync(workRoot, { recursive: true, mode: 0o755 });
  const work = mkdtempSync(join(workRoot, 'app-'));
  try {
    const home = join(work, 'home');
    const tree = join(work, 'tree');
    mkdirSync(home); mkdirSync(tree);
    for (const f of STORE_INSTALL_INPUTS) {
      const src = join(appDir, f);
      if (existsSync(src) && lstatSync(src).isFile()) copyFileSync(src, join(tree, f));
    }
    for (const p of [work, home, tree, ...STORE_INSTALL_INPUTS.map((f) => join(tree, f)).filter((p) => existsSync(p))]) handTo(p);
    const env = unprivilegedInstallEnv(o.env ?? process.env, home);
    const step = (cmd: string, args: string[]) => runAs(cmd, args, { cwd: tree, env, uid, gid, setId: isRoot || o.uid !== undefined }, o.onLine);

    if (o.npm) {
      result.ran.push('npm install');
      const args = [...STORE_INSTALL_ARGS, `--cache=${cache}`];
      let code = await step('npm', args);
      if (code !== 0) {
        // --prefer-offline can fail on a stale/partial cache: the same retry the entrypoint has.
        o.onLine?.('npm install --prefer-offline failed, retrying online…');
        code = await step('npm', args.filter((a) => a !== '--prefer-offline'));
        if (code !== 0) throw new Error(`npm install failed in ${appDir} (exit ${code})`);
      }
    }
    if (o.sdk) {
      result.ran.push('aura sdk install');
      const code = await step('aura', ['sdk', 'install', '--quiet']);
      if (code !== 0) {
        // Left to the entrypoint to retry at launch. Surfaced so a broken registry is visible.
        result.warnings.push(`aura sdk install failed (exit ${code}) — @aura/* packages will be pulled at first launch instead`);
      }
    }

    // Into the app, as root: never through the install user, never following its symlinks.
    const built = join(tree, 'node_modules');
    const target = join(appDir, 'node_modules');
    if (o.npm && existsSync(built)) {
      replaceDir(built, target);
      await handBack(target, isRoot);
    } else if (existsSync(join(built, '@aura'))) {
      mkdirSync(join(target, '@aura'), { recursive: true });
      for (const name of readdirSync(join(built, '@aura'))) replaceDir(join(built, '@aura', name), join(target, '@aura', name));
      await handBack(join(target, '@aura'), isRoot);
    }
    return result;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function replaceDir(src: string, dst: string): void {
  rmSync(dst, { recursive: true, force: true });
  try { renameSync(src, dst); }
  catch { cpSync(src, dst, { recursive: true, verbatimSymlinks: true }); }
}

/** Hand a tree the install user built to root (recursively, symlinks themselves, never their targets). */
async function handBack(dir: string, isRoot: boolean): Promise<void> {
  if (!isRoot) return;
  const code = await runAs('chown', ['-R', '-h', '0:0', dir], { cwd: '/', env: process.env, uid: 0, gid: 0, setId: false });
  if (code !== 0) throw new Error(`could not hand ${dir} back to root`);
}

function runAs(
  cmd: string, args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv | Record<string, string>; uid: number; gid: number; setId: boolean },
  onLine?: (line: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'],
      ...(o.setId ? { uid: o.uid, gid: o.gid } : {}),
    });
    const emit = (d: Buffer) => { for (const l of d.toString().split('\n')) if (l.trim()) onLine?.(l.trim()); };
    child.stdout?.on('data', emit);
    child.stderr?.on('data', emit);
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
  });
}
