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
 *   4. A file the deny list keeps out as runtime data or a secret must not be
 *      TRACKED either: a release leaves it out, but the source repo (`aura dev
 *      publish`, any git push) carries it. A publish refuses while one is
 *      tracked (`refuseTrackedRuntimeData`, D105 `runtime-data-tracked`);
 *      `aura dev validate` warns. `runtimeDataIgnoreLines` is what keeps them
 *      untracked (the scaffold's .gitignore carries the same lines).
 *
 * Paths are relative to the app dir, `/`-separated, files and symlinks only.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AuraErrorBody } from '../errors/contracts.js';

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
  /^auth\.json$/i, /^token(s)?\.json$/i, /^secrets?\.json$/i,
  /^\.claude\.json$/,                                      // a CLI login's account file (home, never source)
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

/**
 * An instance's data dir at the app root: `<appId>` or `<appId>-<n>`. In the
 * global and user scopes an app's dir is also its data dir (AppManager:
 * `<scope data>/apps/<appId>/<instanceId>`).
 */
export function isInstanceDataDir(name: string, appId: string): boolean {
  return name === appId || (name.startsWith(`${appId}-`) && /^\d+$/.test(name.slice(appId.length + 1)));
}

/** An app-root entry that is runtime state, not code: an instance data dir, `.sidecars/` (sidecar volumes), `.data/`. */
export function isRuntimeDataEntry(name: string, appId: string): boolean {
  return name === '.sidecars' || name === '.data' || isInstanceDataDir(name, appId);
}

/**
 * The .gitignore lines that keep an app's runtime data and credentials out of
 * its repository. The scaffold template (`aura dev new`) carries the same
 * lines; `aura dev publish` puts them in `.git/info/exclude` when it makes a
 * repo of an existing app dir.
 */
export function runtimeDataIgnoreLines(appId: string): string[] {
  return [
    `/${appId}/`, `/${appId}-[0-9]*/`, '.sidecars/', '/.data/',
    '.env', '.env.*', '!.env.example', 'secrets.json', 'auth.json', '.credentials.json', '.claude.json',
    '*.db', '*.db-*', '*.sqlite', '*.sqlite3',
  ];
}

/** Deny-list reasons that mean runtime data or a secret (not just build output): tracked, they are refused. */
const SENSITIVE_REASONS = new Set([
  'app data dir', '.sidecars/', '.sidecars', '.data/', '.data', 'secret or runtime data', 'contains a registry login',
]);

/** Why the deny list keeps `rel` out, or null when it may ship. */
export function withheldReason(rel: string, appId: string, readFile?: (rel: string) => string): string | null {
  const parts = rel.split('/');
  const base = parts[parts.length - 1] ?? '';
  if (parts.length > 1 && isInstanceDataDir(parts[0]!, appId)) return 'app data dir';
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

/**
 * How the shell runs read-only git in an author's tree. Since 5-main an author's app (user scope, `aura dev new`)
 * belongs to the author's uid, not root, and git refuses a repo another user owns ("dubious ownership"). Lifting
 * that check as root would let the tree's own `.git/config` (core.fsmonitor, filter drivers, ...) run commands as
 * root. So git runs as the tree's owner: it can only do what that user could do anyway. No system or global config
 * (root's home is not theirs to read, and its settings are not the author's). A root-owned tree, or a shell not
 * running as root, keeps plain git.
 */
export function authorGitOptions(dir: string): { cwd: string; uid?: number; gid?: number; env?: NodeJS.ProcessEnv } {
  let owner: { uid: number; gid: number };
  try { owner = statSync(dir); } catch { return { cwd: dir }; }
  if (process.getuid?.() !== 0 || owner.uid === 0) return { cwd: dir };
  const { XDG_CONFIG_HOME: _xdg, ...env } = process.env;
  return {
    cwd: dir, uid: owner.uid, gid: owner.gid,
    env: { ...env, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  };
}

/** Git's view of the dir, or null when it is not inside a work tree. */
function gitCandidates(appPath: string): string[] | null {
  const as = authorGitOptions(appPath);
  try {
    const inside = execFileSync('git', ['-C', appPath, 'rev-parse', '--is-inside-work-tree'],
      { ...as, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).toString().trim();
    if (inside !== 'true') return null;
    const out = execFileSync('git', ['-C', appPath, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { ...as, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 256 * 1024 * 1024 }).toString();
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
        if (DENY_DIRS.has(name) || (!rel && isInstanceDataDir(name, appId)) || ignoredByManifest(r, ignore)) continue;
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

// ─── tracked runtime data ───────────────────────────────────────────────────

/** A tracked file that is runtime data or a secret, and the deny-list reason. */
export interface TrackedRuntimeFile { file: string; reason: string }

function gitText(appPath: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', appPath, '-c', 'core.quotePath=false', ...args],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 256 * 1024 * 1024 }).toString();
  } catch { return null; }
}

/**
 * Tracked files of `appPath` that the deny list keeps out as runtime data or
 * a secret: the index, and with `pushing` also every file the commits of that
 * revision range add or change (e.g. `['main', '--not', '--remotes']`: what a
 * push of `main` sends). Contents (an rc file's login) are read from git, not
 * the work tree. [] outside a git work tree. Names only: nothing is printed.
 */
export function trackedRuntimeData(appPath: string, appId: string, opts: { pushing?: string[] } = {}): TrackedRuntimeFile[] {
  const found = new Map<string, string>();
  const check = (rel: string, blob: string) => {
    if (!rel || found.has(rel)) return;
    const reason = withheldReason(rel, appId, () => {
      const text = gitText(appPath, ['cat-file', 'blob', blob]);
      if (text === null) throw new Error('unreadable');
      return text;
    });
    if (reason && SENSITIVE_REASONS.has(reason)) found.set(rel, reason);
  };
  const index = gitText(appPath, ['ls-files', '-z', '--cached']);
  if (index === null) return [];
  for (const rel of index.split('\0')) check(rel, `:./${rel}`);
  if (opts.pushing?.length) {
    const log = gitText(appPath, ['log', '--format=%x01%H', '--name-only', '--relative', '--diff-filter=AMRC', ...opts.pushing, '--']) ?? '';
    for (const chunk of log.split('\x01')) {
      const [commit, ...names] = chunk.split('\n').filter(Boolean);
      for (const rel of names) check(rel, `${commit}:./${rel}`);
    }
  }
  return [...found].map(([file, reason]) => ({ file, reason })).sort((a, b) => a.file.localeCompare(b.file));
}

/** The D105 body of a publish refused for tracked runtime data or secrets. */
export function trackedRuntimeDataRefusal(appId: string, files: TrackedRuntimeFile[], action = 'publish'): AuraErrorBody {
  const shown = files.slice(0, 8).map((f) => f.file);
  const more = files.length > shown.length ? `, … (${files.length - shown.length} more)` : '';
  const quoted = shown.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(' ');
  return {
    error: 'runtime-data-tracked',
    message: `${action} refused: ${appId} has ${files.length} tracked file(s) that are runtime data or secrets `
      + `(instance data, sidecar volumes, logins, databases): ${shown.join(', ')}${more}. Nothing was published.`,
    category: 'invalid-request',
    hint: `untrack them (git rm -r --cached -- ${quoted}${more ? ' …' : ''}), add the runtime-data lines to .gitignore `
      + `(${runtimeDataIgnoreLines(appId).slice(0, 4).join(' ')} and the credential files), commit, then publish again. `
      + 'If a commit with them was ever pushed: rotate those credentials and rewrite that history.',
    target: appId,
    details: { files },
  };
}

/** A publish refused by `refuseTrackedRuntimeData`; `body` is the D105 error body. */
export class RuntimeDataTrackedError extends Error {
  constructor(readonly body: AuraErrorBody) {
    super(body.hint ? `${body.message} Fix: ${body.hint}` : body.message);
    this.name = 'RuntimeDataTrackedError';
  }
}

/** Throw RuntimeDataTrackedError when `appPath` tracks runtime data or secrets (see trackedRuntimeData). */
export function refuseTrackedRuntimeData(appPath: string, appId: string, opts: { pushing?: string[]; action?: string } = {}): void {
  const files = trackedRuntimeData(appPath, appId, opts);
  if (files.length) throw new RuntimeDataTrackedError(trackedRuntimeDataRefusal(appId, files, opts.action));
}
