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
 *                     and of the @aura/* packages it builds against
 *   prodCapability  — can this app run from a build at all?
 *   serveState      — 'prod' | 'dev' for the next start, with the reason
 *
 * The build stamp `dist/.aura-build` holds the fingerprint the build was made
 * from; a mismatch means the sources changed since → dev.
 *
 * A build never writes into the live `dist/`: it goes to a staging directory
 * and installBuild() merges it in, so a running server can still lazy-load the
 * chunks it was started with.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppManifest } from '../types/manifest.js';

export const BUILD_STAMP_FILE = '.aura-build';
/** Inside `dist/`, so everything that already ignores builds ignores it too. */
export const BUILD_STAGING_DIR = '.aura-next';

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

/** What a package contributes to a build; types and source maps do not. */
const PACKAGE_RUNTIME_FILE = /\.(?:[cm]?js|css|json)$/;
const AURA_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)['"](@aura\/[a-z0-9-]+)/g;
/** File content hash → the @aura/* packages that file imports. */
const auraImportCache = new Map<string, string[]>();

function auraImportsOf(path: string, hash: string): string[] {
  const hit = auraImportCache.get(hash);
  if (hit) return hit;
  const found = [...new Set([...readFileSync(path, 'utf-8').matchAll(AURA_IMPORT)].map((m) => m[1]!))];
  auraImportCache.set(hash, found);
  return found;
}

function declaredAuraPackages(appDir: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf-8')) as Record<string, Record<string, string> | undefined>;
    const names = [pkg['dependencies'], pkg['devDependencies'], pkg['auraDependencies']].flatMap((d) => Object.keys(d ?? {}));
    return [...new Set(names.filter((n) => n.startsWith('@aura/')))];
  } catch { return []; }
}

function packageRuntimeFiles(pkgDir: string): string[] {
  const files = ['package.json'];
  const walk = (rel: string) => {
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(join(pkgDir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && PACKAGE_RUNTIME_FILE.test(e.name)) files.push(r);
    }
  };
  walk('dist');
  return files.sort();
}

/**
 * Content hash of the @aura/* packages this app builds against: the ones it
 * declares, plus those their runtime files import. Follows workspace symlinks
 * and registry copies alike, so both kinds of app go stale when their SDK
 * changes. '' when the app uses none.
 */
export function sdkFingerprint(appDir: string): string {
  const queue = declaredAuraPackages(appDir).map((name) => ({ name, from: appDir }));
  const seen = new Set<string>();
  const lines: string[] = [];
  const locate = (name: string, from: string) => {
    try { return realpathSync(join(from, 'node_modules', name)); } catch { return null; }
  };
  while (queue.length) {
    const { name, from } = queue.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = locate(name, from) ?? locate(name, appDir);
    if (!dir) { lines.push(`${name}\0missing`); continue; }
    for (const rel of packageRuntimeFiles(dir)) {
      try {
        const hash = fileHash(join(dir, rel));
        lines.push(`${name}/${rel}\0${hash}`);
        if (rel !== 'package.json' && !rel.endsWith('.css')) {
          for (const dep of auraImportsOf(join(dir, rel), hash)) queue.push({ name: dep, from: dir });
        }
      } catch { /* vanished mid-walk */ }
    }
  }
  if (!lines.length) return '';
  return createHash('sha1').update(lines.sort().join('\n')).digest('hex');
}

/**
 * Fingerprint of an app's SOURCES: root config files plus everything under
 * src/ and public/, and the @aura/* packages it uses (sdkFingerprint).
 * Excluded: builds (dist*), node_modules, .astro, the
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
  const sdk = sdkFingerprint(appDir);
  if (sdk) h.update('@aura\0').update(sdk).update('\n');
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

/** An empty staging directory for the next build (a crashed build may have left one). */
export function prepareBuildStaging(appDir: string): string {
  const next = join(appDir, 'dist', BUILD_STAGING_DIR);
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });
  return next;
}

export function discardBuildStaging(appDir: string): void {
  rmSync(join(appDir, 'dist', BUILD_STAGING_DIR), { recursive: true, force: true });
}

function listBuildFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === BUILD_STAGING_DIR) continue;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk('');
  return out;
}

/** Referenced files land before what references them: chunks, then pages, then the entry. */
function installRank(rel: string): number {
  if (rel === 'server/entry.mjs') return 2;
  return rel.startsWith('server/pages/') || /^server\/[^/]+\.mjs$/.test(rel) ? 1 : 0;
}

/** Make `dist/<rel>` placeable when an old build had a file where this one has a directory, or the reverse. */
function clearPathConflicts(dist: string, rel: string): void {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = join(dist, ...parts.slice(0, i));
    try { if (!lstatSync(parent).isDirectory()) rmSync(parent, { force: true }); } catch { break; }
  }
  mkdirSync(dirname(join(dist, rel)), { recursive: true });
  try {
    if (lstatSync(join(dist, rel)).isDirectory()) rmSync(join(dist, rel), { recursive: true, force: true });
  } catch { /* nothing there */ }
}

/**
 * Move a finished build from staging into `dist/`.
 *
 * Merges instead of replacing the directory: a running production server
 * lazy-loads its hashed chunks by path, so they must outlive the build. Each
 * file lands by rename. With `prune` (nothing runs from this dist) files of
 * older builds are removed afterwards. The stamp goes first and the caller
 * writes the new one last, so an interrupted install reads as "changed" → dev.
 */
export function installBuild(appDir: string, opts: { prune: boolean }): void {
  const dist = join(appDir, 'dist');
  const next = join(dist, BUILD_STAGING_DIR);
  const files = listBuildFiles(next);
  if (!files.includes('server/entry.mjs')) throw new Error('the build produced no server/entry.mjs');
  rmSync(join(dist, BUILD_STAMP_FILE), { force: true });
  for (const rel of [...files].sort((a, b) => installRank(a) - installRank(b))) {
    clearPathConflicts(dist, rel);
    const tmp = `${join(dist, rel)}.aura-tmp`;
    rmSync(tmp, { force: true });
    cpSync(join(next, rel), tmp, { verbatimSymlinks: true });
    renameSync(tmp, join(dist, rel));
  }
  if (opts.prune) {
    const keep = new Set(files);
    for (const rel of listBuildFiles(dist)) if (!keep.has(rel)) rmSync(join(dist, rel), { force: true });
    const dropEmpty = (rel: string) => {
      for (const e of readdirSync(join(dist, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (!e.isDirectory() || r === BUILD_STAGING_DIR) continue;
        dropEmpty(r);
        if (!readdirSync(join(dist, r)).length) rmSync(join(dist, r), { recursive: true, force: true });
      }
    };
    dropEmpty('');
  }
  rmSync(next, { recursive: true, force: true });
}

const SECRET_ASSIGNMENT = /([\w.-]*(?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|credential|cookie|authorization)[\w.-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;

/**
 * One log-safe line saying why a build failed: the last error line of its
 * output, with anything shaped like a credential removed.
 */
export function buildFailureReason(r: { skipped?: string; output?: string }): string {
  if (r.skipped) return r.skipped;
  // eslint-disable-next-line no-control-regex
  const lines = (r.output ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const line = [...lines].reverse().find((l) => /error|failed|cannot|could not|not found|timed out|killed/i.test(l)) ?? lines.at(-1) ?? 'no build output';
  return line
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//***@')
    .replace(/\bbearer\s+\S+/gi, 'Bearer ***')
    .replace(SECRET_ASSIGNMENT, '$1***')
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '***')
    .slice(0, 300);
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
