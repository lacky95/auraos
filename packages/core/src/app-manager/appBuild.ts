/**
 * Astro apps from a production build — with an automatic fallback to dev.
 *
 * An app runs from its `astro build` output (`dist/`) when that build matches
 * its current sources, and with `astro dev` otherwise — so editing an app
 * works exactly as before (reload the window), and a build makes it fast
 * again. Builds never run when an app starts (they would blow the health and
 * cold-start budgets): Settings → About → Update / Rebuild builds what
 * changed, and `aura build app <id>` builds on demand.
 *
 *   appFingerprint  — hash of the app's sources (not its data, builds, logs)
 *   prodCapability  — can this app run from a build at all?
 *   serveState      — 'prod' | 'dev' for the next start, with the reason
 *
 * The build stamp `dist/.aura-build` holds the fingerprint the build was made
 * from; a mismatch means the sources changed since → dev.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppManifest } from '../types/manifest.js';

export const BUILD_STAMP_FILE = '.aura-build';

export type ServeMode = 'prod' | 'dev';
export type ServeReason =
  | 'built'            // prod: the build matches the sources
  | 'changed'          // dev: sources changed since the last build
  | 'no-build'         // dev: never built
  | 'dev-only'         // dev: uses dev-server-only hooks (no opt-in), or manifest serve: 'dev'
  | 'own-entrypoint';  // the app starts itself (entrypoint.sh / runtime raw) — not managed

export interface ServeState { mode: ServeMode; reason: ServeReason; detail?: string }

/** Files directly in the app root that are sources. */
const ROOT_SOURCE = /^(astro\.config\.[cm]?[jt]s|package\.json|tsconfig[^/]*\.json|pnpm-lock\.yaml|package-lock\.json|[^/]+\.mjs)$/;
/** Directories (recursively) that are sources. */
const SOURCE_DIRS = ['src', 'public'];
/** Never sources, at any depth. */
const SKIP_DIRS = new Set(['node_modules', '.astro', '.git', '.data', '.cache']);
/** Backups, logs and editor leftovers — changed by tools, not by the author. */
const SKIP_FILES = /(\.bak[^/]*|\.log|~|\.swp|\.orig)$/;

function globToRegExp(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]');
  return new RegExp(`^${re}$`);
}

/** Per-file hash cache: (path, size, mtime) → sha1, so a re-check only reads changed files. */
const fileHashCache = new Map<string, { size: number; mtimeMs: number; hash: string }>();
function fileHash(path: string): string {
  const st = statSync(path);
  const hit = fileHashCache.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.hash;
  const hash = createHash('sha1').update(readFileSync(path)).digest('hex');
  fileHashCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, hash });
  return hash;
}

/**
 * Fingerprint of an app's SOURCES: root config files plus everything under
 * src/ and public/. Excluded: builds (dist*), node_modules, .astro, the
 * instance data dirs (`<appDir>/<appId>…/` — user-scope apps keep data inside
 * the app dir), backups, logs, and the manifest's `build.ignore` globs
 * (paths relative to the app dir).
 */
export function appFingerprint(appDir: string, ignore: readonly string[] = []): string {
  const ignoreRes = ignore.map(globToRegExp);
  const files: string[] = [];
  const skipped = (rel: string) => SKIP_FILES.test(rel) || ignoreRes.some((r) => r.test(rel));
  let rootEntries: string[] = [];
  try { rootEntries = readdirSync(appDir); } catch { return ''; }
  for (const name of rootEntries) {
    if (ROOT_SOURCE.test(name) && !skipped(name)) {
      try { if (statSync(join(appDir, name)).isFile()) files.push(name); } catch { /* vanished */ }
    }
  }
  const walk = (rel: string) => {
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(join(appDir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('dist') && !skipped(r + '/')) walk(r);
      } else if (e.isFile() && !skipped(r)) {
        files.push(r);
      }
    }
  };
  for (const d of SOURCE_DIRS) walk(d);
  files.sort();
  const h = createHash('sha1');
  for (const rel of files) {
    try { h.update(rel).update('\0').update(fileHash(join(appDir, rel))).update('\n'); } catch { /* vanished mid-walk */ }
  }
  return h.digest('hex');
}

/** Features that only exist under `astro dev`: a build silently loses them. */
const DEV_ONLY_HOOKS = /astro:server:setup|configureServer|ssrLoadModule|\bproxy\s*:/;

function astroConfigText(appDir: string): string | null {
  for (const name of ['astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'astro.config.cjs', 'astro.config.mts']) {
    const p = join(appDir, name);
    if (existsSync(p)) { try { return readFileSync(p, 'utf-8'); } catch { return null; } }
  }
  return null;
}

/**
 * Can this app run from a build? Apps the runner starts with its own
 * `astro dev` command can, unless their Astro config hooks into the dev
 * server (WebSockets, proxies, modules loaded into the dev server): those
 * need a `server.mjs` that does the same in production, and stay on dev
 * until their manifest opts in with `"serve": "auto"`. `"serve": "dev"`
 * keeps any app on dev.
 */
export function prodCapability(appDir: string, manifest: AppManifest): { capable: boolean; reason?: ServeReason; detail?: string } {
  if (manifest.runtime === 'raw' || existsSync(join(appDir, manifest.entrypoint))) {
    return { capable: false, reason: 'own-entrypoint' };
  }
  const serve = manifest.serve;
  if (serve === 'dev') return { capable: false, reason: 'dev-only', detail: 'manifest serve: dev' };
  const config = astroConfigText(appDir);
  if (config === null) return { capable: false, reason: 'dev-only', detail: 'no astro.config' };
  if (DEV_ONLY_HOOKS.test(config) && serve !== 'auto') {
    return { capable: false, reason: 'dev-only', detail: 'astro.config hooks into the dev server (needs server.mjs + manifest "serve": "auto")' };
  }
  return { capable: true };
}

export function readBuildStamp(appDir: string): string | null {
  try { return readFileSync(join(appDir, 'dist', BUILD_STAMP_FILE), 'utf-8').trim() || null; } catch { return null; }
}

export function writeBuildStamp(appDir: string, fingerprint: string): void {
  writeFileSync(join(appDir, 'dist', BUILD_STAMP_FILE), `${fingerprint}\n`);
}

/** How the app starts next time, and why. */
export function serveState(appDir: string, manifest: AppManifest): ServeState {
  const cap = prodCapability(appDir, manifest);
  if (!cap.capable) return { mode: 'dev', reason: cap.reason ?? 'dev-only', ...(cap.detail ? { detail: cap.detail } : {}) };
  if (!existsSync(join(appDir, 'dist', 'server', 'entry.mjs'))) return { mode: 'dev', reason: 'no-build' };
  const stamp = readBuildStamp(appDir);
  const ignore = manifest.build?.ignore ?? [];
  if (!stamp || stamp !== appFingerprint(appDir, ignore)) return { mode: 'dev', reason: 'changed' };
  return { mode: 'prod', reason: 'built' };
}

/** Short label for CLI / UI: `prod`, `dev: changed`, … */
export function serveLabel(s: ServeState): string {
  if (s.reason === 'own-entrypoint') return '-';
  return s.mode === 'prod' ? 'prod' : `dev: ${s.reason.replace('-', ' ')}`;
}
