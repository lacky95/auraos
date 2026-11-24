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
import {
  closeSync, constants as fsc, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync,
  readSync, realpathSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
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

// ── The app's tree, written without following its symlinks ─────────────────
//
// `appDir` is the app's own: a running instance can write to it while the
// shell installs a build, and can swap any directory for a symlink between a
// check and a write. So below `appDir` nothing is reached by path. Each
// directory is opened without following a symlink and held by its fd, and
// every read and write goes through `/proc/self/fd/<fd>/<name>`, which stays
// on that directory whatever happens to the path (Linux, where the shell runs).

const DIR_FLAGS = fsc.O_RDONLY | fsc.O_DIRECTORY | fsc.O_NOFOLLOW;

/** A directory held by fd. `at(name)` is a path to one entry in it. */
class PinnedDir {
  private constructor(private readonly fd: number) {}

  /** `appDir` itself: the shell chose it, so it may be reached by path. */
  static root(path: string): PinnedDir {
    return new PinnedDir(openSync(path, fsc.O_RDONLY | fsc.O_DIRECTORY));
  }

  at(name: string): string {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
      throw new Error(`invalid build path entry: ${JSON.stringify(name)}`);
    }
    return `/proc/self/fd/${this.fd}/${name}`;
  }

  /**
   * The subdirectory `name`. A symlink there is refused. With `create`, a
   * missing one is made and a file in its place replaced (an older build had
   * a file where this one has a directory).
   */
  child(name: string, create = false): PinnedDir {
    const path = this.at(name);
    try {
      return new PinnedDir(openSync(path, DIR_FLAGS));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Linux answers a symlink with ELOOP, or ENOTDIR when O_DIRECTORY is checked first.
      if (code === 'ELOOP' || (code === 'ENOTDIR' && lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())) {
        throw new Error(`refusing a symlink in the build path: ${name}`);
      }
      if (!create || (code !== 'ENOENT' && code !== 'ENOTDIR')) throw err;
    }
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`refusing a symlink in the build path: ${name}`);
    this.remove(name);
    mkdirSync(path);
    return new PinnedDir(openSync(path, DIR_FLAGS));
  }

  /** The subdirectory at `parts` (at least one) below this one; each level passed is closed. */
  descend(parts: readonly string[], create = false): PinnedDir {
    if (parts.length === 0) throw new Error('descend needs a path');
    let dir: PinnedDir = this;
    for (const part of parts) {
      const next = dir.child(part, create);
      if (dir !== this) dir.close();
      dir = next;
    }
    return dir;
  }

  entries() {
    return readdirSync(`/proc/self/fd/${this.fd}`, { withFileTypes: true });
  }

  /** Remove `name` (a file, a symlink itself, or a whole directory). Gone already is fine. */
  remove(name: string): void {
    const path = this.at(name);
    try {
      unlinkSync(path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      if (code !== 'EISDIR' && code !== 'EPERM') throw err;
    }
    const dir = this.child(name);
    try {
      for (const e of dir.entries()) dir.remove(e.name);
    } finally { dir.close(); }
    rmdirSync(path);
  }

  /** Copy the entry `name` here to `dest`'s new entry `as`: a file's bytes, or a symlink as a symlink. */
  copyTo(name: string, dest: PinnedDir, as: string): void {
    const src = this.at(name);
    let fd: number;
    try {
      fd = openSync(src, fsc.O_RDONLY | fsc.O_NOFOLLOW);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ELOOP') throw err;
      symlinkSync(readlinkSync(src), dest.at(as));
      return;
    }
    try {
      if (!fstatSync(fd).isFile()) throw new Error(`not a file in the build: ${name}`);
      const out = openSync(dest.at(as), fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o644);
      try {
        const buf = Buffer.allocUnsafe(64 * 1024);
        for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) writeSync(out, buf, 0, n);
      } finally { closeSync(out); }
    } finally { closeSync(fd); }
  }

  /** Write a small file (replacing a file or symlink there). */
  writeFile(name: string, content: string): void {
    this.remove(name);
    const fd = openSync(this.at(name), fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o644);
    try { writeSync(fd, content); } finally { closeSync(fd); }
  }

  /** Whether `name` is a directory here (not following a symlink). */
  isDir(name: string): boolean {
    return lstatSync(this.at(name), { throwIfNoEntry: false })?.isDirectory() ?? false;
  }

  close(): void {
    try { closeSync(this.fd); } catch { /* already closed */ }
  }
}

/** `run(dist)` on the app's `dist/`, pinned; every fd is closed after. */
function withDist<T>(appDir: string, run: (dist: PinnedDir) => T): T {
  const root = PinnedDir.root(appDir);
  try {
    const dist = root.child('dist', true);
    try { return run(dist); } finally { dist.close(); }
  } finally { root.close(); }
}

export function writeBuildStamp(appDir: string, fingerprint: string): void {
  withDist(appDir, (dist) => dist.writeFile(BUILD_STAMP_FILE, `${fingerprint}\n`));
}

/** An empty staging directory for the next build (a crashed build may have left one). */
export function prepareBuildStaging(appDir: string): string {
  withDist(appDir, (dist) => {
    dist.remove(BUILD_STAGING_DIR);
    dist.child(BUILD_STAGING_DIR, true).close();
  });
  return join(appDir, 'dist', BUILD_STAGING_DIR);
}

export function discardBuildStaging(appDir: string): void {
  withDist(appDir, (dist) => dist.remove(BUILD_STAGING_DIR));
}

/** Every non-directory below `dir`, as `a/b/c` paths. A symlink is listed, never followed. */
function listBuildFiles(dir: PinnedDir, skipTop: string | null = null): string[] {
  const out: string[] = [];
  const walk = (d: PinnedDir, rel: string) => {
    for (const e of d.entries()) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === skipTop) continue;
      if (e.isDirectory()) {
        const sub = d.child(e.name);
        try { walk(sub, r); } finally { sub.close(); }
      } else out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

/** Referenced files land before what references them: chunks, then pages, then the entry. */
function installRank(rel: string): number {
  if (rel === 'server/entry.mjs') return 2;
  return rel.startsWith('server/pages/') || /^server\/[^/]+\.mjs$/.test(rel) ? 1 : 0;
}

/** Remove the directories below `dir` that are empty, deepest first. */
function dropEmptyDirs(dir: PinnedDir, skipTop: string | null): void {
  for (const e of dir.entries()) {
    if (!e.isDirectory() || e.name === skipTop) continue;
    const sub = dir.child(e.name);
    let empty: boolean;
    try {
      dropEmptyDirs(sub, null);
      empty = sub.entries().length === 0;
    } finally { sub.close(); }
    if (empty) rmdirSync(dir.at(e.name));
  }
}

/**
 * Move a finished build from staging into `dist/`.
 *
 * Merges instead of replacing the directory: a running production server
 * lazy-loads its hashed chunks by path, so they must outlive the build. Each
 * file lands by rename. With `prune` (nothing runs from this dist) files of
 * older builds are removed afterwards. The stamp goes first and the caller
 * writes the new one last, so an interrupted install reads as "changed" → dev.
 * Every step goes through pinned directories (see PinnedDir): a symlink the
 * app planted anywhere in `dist/` or the staging tree is refused, never followed.
 */
export function installBuild(appDir: string, opts: { prune: boolean }): void {
  withDist(appDir, (dist) => {
    const next = dist.child(BUILD_STAGING_DIR);
    try {
      const files = listBuildFiles(next);
      if (!files.includes('server/entry.mjs')) throw new Error('the build produced no server/entry.mjs');
      dist.remove(BUILD_STAMP_FILE);
      for (const rel of [...files].sort((a, b) => installRank(a) - installRank(b))) {
        const parts = rel.split('/');
        const name = parts.pop()!;
        const from = parts.length ? next.descend(parts) : null;
        const to = parts.length ? dist.descend(parts, true) : null;
        try {
          const src = from ?? next;
          const dst = to ?? dist;
          const tmp = `${name}.aura-tmp`;
          dst.remove(tmp);
          src.copyTo(name, dst, tmp);
          if (dst.isDir(name)) dst.remove(name);
          renameSync(dst.at(tmp), dst.at(name));
        } finally { from?.close(); to?.close(); }
      }
      if (opts.prune) {
        const keep = new Set(files);
        for (const rel of listBuildFiles(dist, BUILD_STAGING_DIR)) {
          if (keep.has(rel)) continue;
          const parts = rel.split('/');
          const name = parts.pop()!;
          const dir = parts.length ? dist.descend(parts) : null;
          try { (dir ?? dist).remove(name); } finally { dir?.close(); }
        }
        dropEmptyDirs(dist, BUILD_STAGING_DIR);
      }
    } finally { next.close(); }
    dist.remove(BUILD_STAGING_DIR);
  });
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
