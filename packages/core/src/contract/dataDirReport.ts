/**
 * The `dataDir` report (D48, Phase 3b): which apps write outside their data
 * directory, so Phase 5 (private homes) and Phase 6 (read-only release) start
 * from a known list. Report only, minimal, from what AuraOS already has:
 *
 *   install-folder  files in the app's install folder changed after its
 *                   manifest (build output and node_modules excluded). The
 *                   install folder is read-only from Phase 6.
 *   container-layer `docker diff` of a running container instance: files the
 *                   app wrote into its image layer, outside every mount. They
 *                   are lost on every restart today.
 *   home            the app's home `~` (its App Home since Phase 5) is
 *                   mounted read-write (the mount info). It is no data
 *                   store: this says only that the app can write there.
 *
 * The documented place for app data is the SDK's `getAppContext().dataDir`
 * (`/data` in the sandbox): it persists and is private to the app.
 */
import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Build output and dependencies: written by the build, not by the running app. */
const BUILD_DIRS = new Set(['node_modules', 'dist', '.astro', '.next', '.turbo', '.cache', '.git', '.svelte-kit', '.output', '.vite']);
/** Container paths that are scratch by nature. */
const SCRATCH = [/^\/tmp(\/|$)/, /^\/var\/tmp(\/|$)/, /^\/run(\/|$)/, /^\/proc(\/|$)/, /^\/dev(\/|$)/, /^\/sys(\/|$)/, /^\/var\/run(\/|$)/];
export const DATADIR_REPORT_MAX_PATHS = 20;
const SCAN_MAX_ENTRIES = 20_000;

export interface DataDirAppInput {
  appId: string;
  scope: string;
  /** Install folder on the shell's filesystem. */
  dir: string;
  sandbox: 'proot' | 'container';
  /** Running instances, container instances with their container name. */
  instances: Array<{ instanceId: string; container?: string }>;
}

export interface DataDirAppReport {
  appId: string;
  scope: string;
  sandbox: 'proot' | 'container';
  installFolder: { writes: string[]; truncated: boolean };
  containerLayer: Array<{ instanceId: string; writes: string[]; truncated: boolean } | { instanceId: string; error: string }>;
  home: 'rw' | 'ro' | 'none' | 'unknown';
  /** True when any write outside dataDir was seen. */
  outside: boolean;
}

export interface DataDirDeps {
  /** `docker diff <container>` lines (`A /path`), or null when it can't be read. */
  dockerDiff(container: string): Promise<string[] | null>;
  /** The container's mounts (destination + rw), or null. */
  dockerMounts(container: string): Promise<Array<{ destination: string; rw: boolean }> | null>;
  /** Files under `dir` changed after the app's manifest, relative paths. */
  installWrites(dir: string): { writes: string[]; truncated: boolean };
  /** The sandbox's home path. */
  homePath: string;
}

/** Install-folder files newer than `app.manifest.json`, skipping build output. */
export function scanInstallWrites(dir: string, max = DATADIR_REPORT_MAX_PATHS): { writes: string[]; truncated: boolean } {
  let since: number;
  try { since = statSync(join(dir, 'app.manifest.json')).mtimeMs; } catch { return { writes: [], truncated: false }; }
  const writes: string[] = [];
  let seen = 0;
  let truncated = false;
  const walk = (d: string): void => {
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > SCAN_MAX_ENTRIES) { truncated = true; return; }
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!BUILD_DIRS.has(e.name)) walk(p);
      } else if (e.isFile()) {
        let m: number;
        try { m = statSync(p).mtimeMs; } catch { continue; }
        if (m > since + 1000) {
          if (writes.length >= max) { truncated = true; return; }
          writes.push(relative(dir, p));
        }
      }
      if (truncated) return;
    }
  };
  walk(dir);
  return { writes: writes.sort(), truncated };
}

/** The `A`/`C` paths of `docker diff` that are files the app wrote, not scratch or parents of others. */
export function layerWrites(lines: readonly string[], max = DATADIR_REPORT_MAX_PATHS): { writes: string[]; truncated: boolean } {
  const paths = lines
    .map((l) => /^([ACD]) (\/.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m && m[1] !== 'D')
    .map((m) => m[2]!)
    .filter((p) => !SCRATCH.some((re) => re.test(p)));
  // `docker diff` lists every changed parent directory too: keep the leaves.
  const leaves = paths.filter((p) => !paths.some((q) => q !== p && q.startsWith(`${p}/`))).sort();
  return { writes: leaves.slice(0, max), truncated: leaves.length > max };
}

export async function dataDirReport(apps: readonly DataDirAppInput[], deps: DataDirDeps): Promise<DataDirAppReport[]> {
  const out: DataDirAppReport[] = [];
  for (const app of apps) {
    const installFolder = deps.installWrites(app.dir);
    const containerLayer: DataDirAppReport['containerLayer'] = [];
    let home: DataDirAppReport['home'] = app.sandbox === 'container' ? 'unknown' : 'rw';
    for (const inst of app.instances) {
      if (!inst.container) continue;
      const diff = await deps.dockerDiff(inst.container);
      containerLayer.push(diff ? { instanceId: inst.instanceId, ...layerWrites(diff) } : { instanceId: inst.instanceId, error: 'docker diff unavailable' });
      const mounts = await deps.dockerMounts(inst.container);
      if (mounts) {
        const h = mounts.find((m) => m.destination === deps.homePath);
        home = h ? (h.rw ? 'rw' : 'ro') : 'none';
      }
    }
    const outside = installFolder.writes.length > 0 || containerLayer.some((c) => 'writes' in c && c.writes.length > 0);
    out.push({ appId: app.appId, scope: app.scope, sandbox: app.sandbox, installFolder, containerLayer, home, outside });
  }
  return out;
}

/** The live deps: the docker CLI the runners use, the shell's filesystem. */
export function liveDataDirDeps(homePath = '/home/aura'): DataDirDeps {
  const docker = async (args: string[]): Promise<string | null> => {
    try { return (await execFileAsync('docker', args, { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })).stdout; } catch { return null; }
  };
  return {
    homePath,
    installWrites: (dir) => scanInstallWrites(dir),
    async dockerDiff(container) {
      const s = await docker(['diff', container]);
      return s === null ? null : s.split('\n').filter(Boolean);
    },
    async dockerMounts(container) {
      const s = await docker(['inspect', '-f', '{{json .Mounts}}', container]);
      if (s === null) return null;
      try {
        const mounts = JSON.parse(s) as Array<{ Destination?: string; RW?: boolean }>;
        return mounts.map((m) => ({ destination: String(m.Destination ?? ''), rw: m.RW === true }));
      } catch { return null; }
    },
  };
}
