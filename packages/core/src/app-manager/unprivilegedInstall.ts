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
 * Remaining for Phase 6 G: run it in a throwaway builder container (no
 * shell network namespace, no loopback services) instead of a uid drop.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chownSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
}

/** Default paths under the data dir. */
export function unprivilegedInstallPaths(dataDir = process.env['AURA_DATA_DIR'] ?? '/data'): UnprivilegedInstallPaths {
  return { storeDir: join(dataDir, 'aura', 'install-store'), toolsDir: join(dataDir, 'aura', 'install-tools') };
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
