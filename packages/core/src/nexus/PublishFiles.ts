/**
 * What a publish ships — one list, used by the git AND the OCI publish, so
 * the two can never disagree about which files leave the machine.
 *
 *   1. Inside a git work tree the candidates are what git would track:
 *      `git ls-files --cached --others --exclude-standard` (so `.gitignore`
 *      counts). Outside one, the app dir is walked.
 *   2. `manifest.publish.ignore[]` drops more: an entry without `/` matches
 *      any path segment (`dist` → every `dist/`), one with `/` a path prefix.
 *      Without the field the old default applies (node_modules, dist, …).
 *   3. A deny list that no manifest can switch off drops runtime data and
 *      secrets: an app dir is also where its instance lives, so it can hold
 *      `.sidecars/<svc>/data`, the per-app data dir `<appId>/`, `.env` files,
 *      keys, databases. Publishing those would ship a customer's state and
 *      logins to everyone who can pull the app.
 *
 * Paths are relative to the app dir, `/`-separated, files and symlinks only.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_PUBLISH_IGNORE = ['node_modules', '.next', 'dist', '.astro', '.turbo', '.cache'];

/** Directory names never published, at any depth. */
const DENY_DIRS = new Set([
  '.git', 'node_modules', '.sidecars', '.pnpm-store', '.data', '.cache', '.turbo', '.astro',
]);

/** File names never published (basename match). */
const DENY_FILES: RegExp[] = [
  /^\.env(\..+)?$/i,                                      // .env, .env.local, … (templates allowed below)
  /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i,
  /\.sqlite\./i,                                          // sqlite side files (x.sqlite.lock.sqlite …)
  /credentials?(\.[a-z0-9-]+)*\.json$/i,                  // trilium-credentials.json, credentials.json
  /^\.netrc$/, /^\.git-credentials$/, /^\.pgpass$/,
  /^auth\.json$/i, /^token(s)?\.json$/i,
];

/** `.env.example` & co. are documentation, not secrets. */
const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist)$/i;

/** Package-manager rc files are fine unless they carry a login. */
const RC_WITH_LOGIN = /^\.(npmrc|yarnrc|yarnrc\.yml)$/;
const RC_LOGIN_LINE = /(_auth|_authToken|_password|npmAuthToken|npmAuthIdent)\s*[=:]/i;

export interface PublishFileList {
  /** Files (and symlinks) to ship, relative to the app dir. */
  files:    string[];
  /** Candidates the deny list kept out — reported, never shipped. */
  withheld: string[];
}

export interface PublishFileOpts {
  /** The app id — its runtime data dir `<appId>/` at the app root is withheld. */
  appId:   string;
  /** `manifest.publish.ignore`; undefined = DEFAULT_PUBLISH_IGNORE. */
  ignore?: string[];
}

/** Why the deny list keeps `rel` out, or null when it may ship. */
export function withheldReason(rel: string, appId: string, readFile?: (rel: string) => string): string | null {
  const parts = rel.split('/');
  const base = parts[parts.length - 1] ?? '';
  if (parts[0] === appId && parts.length > 1) return 'app data dir';
  for (const p of parts.slice(0, -1)) if (DENY_DIRS.has(p)) return `${p}/`;
  if (DENY_DIRS.has(base)) return base;
  if (ENV_TEMPLATE.test(base)) return null;
  for (const re of DENY_FILES) if (re.test(base)) return 'secret or runtime data';
  if (RC_WITH_LOGIN.test(base) && readFile) {
    try { if (RC_LOGIN_LINE.test(readFile(rel))) return 'contains a registry login'; }
    catch { return 'unreadable rc file'; }
  }
  return null;
}

function ignoredByManifest(rel: string, ignore: string[]): boolean {
  const parts = rel.split('/');
  for (const raw of ignore) {
    const i = raw.replace(/^\.?\/+/, '').replace(/\/+$/, '');
    if (!i) continue;
    if (i.includes('/')) { if (rel === i || rel.startsWith(`${i}/`)) return true; }
    else if (parts.includes(i)) return true;
  }
  return false;
}

/** Git's view of the dir, or null when it is not inside a work tree. */
function gitCandidates(appPath: string): string[] | null {
  try {
    const inside = execFileSync('git', ['-C', appPath, 'rev-parse', '--is-inside-work-tree'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).toString().trim();
    if (inside !== 'true') return null;
    const out = execFileSync('git', ['-C', appPath, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 256 * 1024 * 1024 }).toString();
    return out.split('\0').filter(Boolean);
  } catch { return null; }
}

function walkCandidates(appPath: string, ignore: string[], appId: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    let entries: string[];
    try { entries = readdirSync(join(appPath, rel)); } catch { return; }
    for (const name of entries) {
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try { st = lstatSync(join(appPath, r)); } catch { continue; }
      if (st.isDirectory()) {
        // Prune early: never descend into what can't ship anyway.
        if (DENY_DIRS.has(name) || (!rel && name === appId) || ignoredByManifest(r, ignore)) continue;
        walk(r);
      } else if (st.isFile() || st.isSymbolicLink()) out.push(r);
    }
  };
  walk('');
  return out;
}

export function publishFileList(appPath: string, opts: PublishFileOpts): PublishFileList {
  const ignore = opts.ignore ?? DEFAULT_PUBLISH_IGNORE;
  const candidates = gitCandidates(appPath) ?? walkCandidates(appPath, ignore, opts.appId);
  const readFile = (rel: string) => readFileSync(join(appPath, rel), 'utf-8');
  const files: string[] = [];
  const withheld: string[] = [];
  for (const rel of [...new Set(candidates)].sort()) {
    let st;
    try { st = lstatSync(join(appPath, rel)); } catch { continue; }   // tracked but deleted
    if (!st.isFile() && !st.isSymbolicLink()) continue;
    if (ignoredByManifest(rel, ignore)) continue;
    if (withheldReason(rel, opts.appId, readFile)) { withheld.push(rel); continue; }
    files.push(rel);
  }
  return { files, withheld };
}
