/**
 * The system mode (D30, D60): `developer` (AuraOS runs from its `/workspace`
 * checkout, the owner develops it) or `normal` (the locked release). This
 * module is the one place it is read and written.
 *
 *   AURA_SYSTEM_MODE on the container  wins (like AURA_SHELL_MODE)
 *   /data/aura/system-mode             the switch (Settings → System, `aura mode`)
 *   neither                            `normal` (Phase 6). Every install that ran
 *                                      before Phase 6, and every Developer layout,
 *                                      has the file: `migrateSystemModeFile()`
 *                                      writes `developer` at boot (D60)
 *
 * Normal mode is recorded and shown, but NOT enforced yet: AuraOS still runs
 * from /workspace either way. What the mode changes today: the desktop
 * indicator, `aura dev rebuild|restart` and `aura mount workspace` (Developer
 * Mode only), and the access context's `systemMode`.
 *
 * Switching off runs the clean-tree flow (D4, D60): `workspaceTree()` lists
 * what differs from the release, `exportPatches()` writes it as patch files,
 * and `moveToDevBranch()` is the explicit automatic clean-up. Docs:
 * developer-mode.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import type { SystemMode } from './access/types.ts';

export const SYSTEM_MODES: readonly SystemMode[] = ['normal', 'developer'];
/**
 * Without the switch file (Phase 6): only a fresh Normal-layout install
 * (`install.sh`, a release tree) gets here; `migrateSystemModeFile()` gives
 * every checkout install `developer` before anything reads the mode.
 */
export const DEFAULT_SYSTEM_MODE: SystemMode = 'normal';
/** How long the automatic clean-up keeps its backup (D4). */
export const DEV_BACKUP_DAYS = 30;

const dataDir = (): string => process.env['AURA_DATA_DIR'] ?? '/data';
const workspaceDir = (): string => process.env['AURA_WORKSPACE_DIR'] ?? '/workspace';
export const systemModeFile = (): string => join(dataDir(), 'aura', 'system-mode');
export const devPatchesDir = (): string => join(dataDir(), 'aura', 'dev-patches');
export const devBackupsDir = (): string => join(dataDir(), 'aura', 'dev-backups');

const isMode = (v: unknown): v is SystemMode => v === 'normal' || v === 'developer';

export interface SystemModeState {
  /** The mode in effect. */
  mode: SystemMode;
  /** The switch file, null when unset. */
  configured: SystemMode | null;
  /** AURA_SYSTEM_MODE on the container, which wins over the file. */
  env: SystemMode | null;
  default: SystemMode;
  /** Whether Normal mode locks the source. Not before Phase 6. */
  normalEnforced: false;
}

function readConfigured(): SystemMode | null {
  try {
    const v = readFileSync(systemModeFile(), 'utf8').trim();
    return isMode(v) ? v : null;
  } catch { return null; }
}

function readEnv(): SystemMode | null {
  const v = process.env['AURA_SYSTEM_MODE']?.trim();
  return isMode(v) ? v : null;
}

export function systemModeState(): SystemModeState {
  const configured = readConfigured();
  const env = readEnv();
  return {
    mode: env ?? configured ?? DEFAULT_SYSTEM_MODE,
    configured, env, default: DEFAULT_SYSTEM_MODE, normalEnforced: false,
  };
}

// The access context asks on every request: the file is cached briefly, dropped on a write.
const CACHE_MS = 2_000;
let cached: { file: string; configured: SystemMode | null; at: number } | null = null;

/** The mode in effect (the switch file cached briefly). */
export function systemMode(now = Date.now()): SystemMode {
  const file = systemModeFile();
  if (!cached || cached.file !== file || now - cached.at >= CACHE_MS) cached = { file, configured: readConfigured(), at: now };
  return readEnv() ?? cached.configured ?? DEFAULT_SYSTEM_MODE;
}

export const isDeveloperMode = (): boolean => systemMode() === 'developer';

/** Write the switch; announce the mode in effect to open desktops. */
export function writeSystemMode(mode: SystemMode): SystemModeState {
  mkdirSync(dirname(systemModeFile()), { recursive: true });
  writeFileSync(systemModeFile(), `${mode}\n`, 'utf8');
  cached = null;
  const state = systemModeState();
  try { core.OsEventBus.emit('os:systemModeChanged', { mode: state.mode }); } catch { /* no bus in tests */ }
  return state;
}

// ── the Phase 6 migration (D60: existing installs stay developer) ──────────

export interface SystemModeMigration {
  /** Always `developer`: the mode this install ran in before (the old default). */
  mode: 'developer';
  /** Why: no switch file, or one that names no mode (both read as the old default). */
  reason: 'no-file' | 'invalid-file';
  workspace: string;
}

/**
 * An install with no valid switch file whose `/workspace` is a git checkout
 * (the Developer layout: every install before Phase 6, and `install.sh
 * --developer`) gets `developer` written, so the Normal default never changes
 * its mode. A release tree (the Normal layout) has no `.git` and keeps the
 * default. Sync and idempotent; a set file or AURA_SYSTEM_MODE is never
 * touched. Called once at boot before anything reads the mode (middleware
 * init, then `bootSystem()`); `audit` gets the `system-mode.migrated` row.
 */
export function migrateSystemModeFile(
  audit?: (entry: { by: { kind: 'system' }; action: string; target: string; outcome: 'ok'; detail: Record<string, unknown> }) => Promise<unknown>,
): SystemModeMigration | null {
  if (readConfigured() !== null) return null;
  const file = systemModeFile();
  // Only a missing file or one without a mode: an unreadable one stays as it is.
  let reason: SystemModeMigration['reason'] = 'no-file';
  try { readFileSync(file, 'utf8'); reason = 'invalid-file'; }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
  const workspace = workspaceDir();
  let checkout = false;
  try { checkout = statSync(join(workspace, '.git')) !== null; } catch { /* no checkout */ }
  if (!checkout) return null;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'developer\n', 'utf8');
  cached = null;
  console.log(`[systemMode] ${workspace} is a git checkout and ${file} had no mode: wrote developer (D60)`);
  const migration: SystemModeMigration = { mode: 'developer', reason, workspace };
  // The audit trail must never fail the boot.
  const warn = (err: unknown) => console.warn(`[systemMode] audit of the migration failed: ${(err as Error).message}`);
  try {
    audit?.({ by: { kind: 'system' }, action: 'system-mode.migrated', target: 'system:mode', outcome: 'ok', detail: { ...migration } })
      .catch(warn);
  } catch (err) { warn(err); }
  return migration;
}

// ── the checkout: what differs from the release (D4) ───────────────────────

/** Lists are capped; the counts are not. */
const LIST_CAP = 200;

export interface WorkspaceTree {
  /** Whether the checkout is a git repository at all. */
  git: boolean;
  branch: string | null;
  head: string | null;
  /**
   * The release commit: until Phase 6 builds releases, the last fetched
   * `main` of the remote this install updates from (no network here).
   */
  release: { ref: string; commit: string } | null;
  /** Tracked files with uncommitted changes (staged or not). */
  uncommitted: string[];
  /** Untracked files, ignored ones excluded. */
  untracked: string[];
  /** Commits on HEAD that the release does not have. */
  localCommits: Array<{ sha: string; subject: string }>;
  counts: { uncommitted: number; untracked: number; localCommits: number };
  /** Nothing differs from the release. */
  clean: boolean;
}

function git(args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): string {
  const ws = opts.cwd ?? workspaceDir();
  return execFileSync('git', ['-C', ws, '-c', `safe.directory=${ws}`, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
  }).replace(/\n$/, '');
}

const tryGit = (args: string[]): string | null => { try { return git(args); } catch { return null; } };
const lines = (s: string | null): string[] => (s ? s.split('\n').filter(Boolean) : []);

/** The remote's `main` as last fetched: the same remote the updater uses (SelfUpdater.remoteInfo). */
function releaseRef(): { ref: string; commit: string } | null {
  let remote = tryGit(['config', '--get', 'branch.main.remote']) ?? '';
  if (!remote) {
    const all = lines(tryGit(['remote']));
    remote = all.includes('origin') ? 'origin' : (all[0] ?? '');
  }
  if (!remote) return null;
  const ref = `refs/remotes/${remote}/main`;
  const commit = tryGit(['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  return commit ? { ref: `${remote}/main`, commit } : null;
}

/** What differs between the checkout and the release. Reads only. */
export function workspaceTree(): WorkspaceTree {
  const empty: WorkspaceTree = {
    git: false, branch: null, head: null, release: null, uncommitted: [], untracked: [], localCommits: [],
    counts: { uncommitted: 0, untracked: 0, localCommits: 0 }, clean: true,
  };
  const head = tryGit(['rev-parse', '--verify', '-q', 'HEAD']);
  if (head === null) return empty;
  const branch = tryGit(['symbolic-ref', '-q', '--short', 'HEAD']);
  const release = releaseRef();
  // -z: paths verbatim. Porcelain v1 entries are "XY path", a rename adds the old path as its own entry.
  const status = (tryGit(['status', '--porcelain', '-z', '--untracked-files=all']) ?? '').split('\0');
  const uncommitted: string[] = [];
  const untracked: string[] = [];
  for (let i = 0; i < status.length; i++) {
    const e = status[i]!;
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const path = e.slice(3);
    if (xy === '??') untracked.push(path);
    else if (xy !== '!!') uncommitted.push(path);
    if (xy[0] === 'R' || xy[0] === 'C') i++;   // skip the old path
  }
  const localCommits = release
    ? lines(tryGit(['log', '--format=%h %s', `${release.commit}..HEAD`])).map((l) => {
      const at = l.indexOf(' ');
      return { sha: l.slice(0, at), subject: l.slice(at + 1) };
    })
    : [];
  const counts = { uncommitted: uncommitted.length, untracked: untracked.length, localCommits: localCommits.length };
  return {
    git: true, branch, head, release,
    uncommitted: uncommitted.slice(0, LIST_CAP), untracked: untracked.slice(0, LIST_CAP),
    localCommits: localCommits.slice(0, LIST_CAP), counts,
    clean: counts.uncommitted + counts.untracked + counts.localCommits === 0,
  };
}

/** `2026-11-25T18-30-05`: sortable, never a path separator or an option. */
export const stamp = (d = new Date()): string => d.toISOString().slice(0, 19).replace(/:/g, '-');

export interface PatchExport {
  dir: string;
  files: string[];
}

/**
 * Write everything that differs as patch files, changing nothing in the
 * checkout (D60 (b)): `commits/` (`git format-patch` of the local commits),
 * `uncommitted.diff` (tracked changes against HEAD), `untracked.diff` (new
 * files) and a README with how to apply them.
 */
export function exportPatches(into = join(devPatchesDir(), stamp())): PatchExport {
  const tree = workspaceTree();
  if (!tree.git) throw new Error(`${workspaceDir()} is not a git checkout`);
  mkdirSync(into, { recursive: true });
  const files: string[] = [];
  if (tree.release && tree.counts.localCommits > 0) {
    const out = join(into, 'commits');
    files.push(...lines(git(['format-patch', '-o', out, `${tree.release.commit}..HEAD`])).map((f) => f.slice(into.length + 1)));
  }
  if (tree.counts.uncommitted > 0) {
    writeFileSync(join(into, 'uncommitted.diff'), git(['diff', '--binary', 'HEAD']) + '\n');
    files.push('uncommitted.diff');
  }
  if (tree.counts.untracked > 0) {
    // Every untracked file, not only the listed ones.
    const paths = git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean);
    const parts: string[] = [];
    for (const p of paths) {
      try { parts.push(git(['diff', '--no-index', '--binary', '--', '/dev/null', p])); }
      catch (err) {
        // `git diff --no-index` exits 1 when the files differ, which they always do here.
        const out = (err as { stdout?: string }).stdout;
        if (typeof out === 'string' && out) parts.push(out.replace(/\n$/, ''));
      }
    }
    writeFileSync(join(into, 'untracked.diff'), parts.join('\n') + '\n');
    files.push('untracked.diff');
  }
  writeFileSync(join(into, 'README.txt'), [
    'AuraOS Developer Mode changes, saved when Developer Mode was switched off.',
    '',
    `checkout: ${workspaceDir()}`,
    `branch:   ${tree.branch ?? '(detached)'}`,
    `HEAD:     ${tree.head}`,
    `release:  ${tree.release ? `${tree.release.ref} ${tree.release.commit}` : 'unknown (no fetched remote main)'}`,
    '',
    'Apply on top of that release:',
    '  git am commits/*.patch',
    '  git apply uncommitted.diff untracked.diff',
    '',
  ].join('\n'));
  files.push('README.txt');
  return { dir: into, files };
}

export interface DevBranchResult {
  branch: string;
  /** The commit the branch points at: HEAD plus every uncommitted and untracked change. */
  commit: string;
  /** `main`'s own local commits, when another branch was checked out. */
  mainBranch?: string;
  backup: string;
  release: { ref: string; commit: string };
}

/**
 * The automatic clean-up (D4, D60 (c)), only ever on the owner's explicit
 * choice: everything that differs goes to a new `dev/<date>` branch, a backup
 * (patch files and a git bundle) is kept for DEV_BACKUP_DAYS days, and the
 * checkout is reset to the release on `main`. Ignored files (node_modules,
 * build output) are left alone.
 */
export function moveToDevBranch(now = new Date()): DevBranchResult {
  const tree = workspaceTree();
  if (!tree.git || !tree.head) throw new Error(`${workspaceDir()} is not a git checkout`);
  if (!tree.release) throw new Error('no release commit is known (the remote main was never fetched): commit and push, or clean up by hand');
  const release = tree.release;
  const at = stamp(now);
  const branch = `dev/${at}`;
  if (tryGit(['rev-parse', '--verify', '-q', `refs/heads/${branch}`])) throw new Error(`${branch} exists already`);

  // A commit of the whole working tree on top of HEAD, through a separate
  // index: the checkout's own index and files are not touched yet.
  let commit = tree.head;
  if (tree.counts.uncommitted + tree.counts.untracked > 0) {
    const tmp = mkdtempSync(join(tmpdir(), 'aura-devmode-'));
    try {
      const env = { GIT_INDEX_FILE: join(tmp, 'index'), ...identityEnv() };
      git(['read-tree', 'HEAD'], { env });
      git(['add', '-A'], { env });
      const treeId = git(['write-tree'], { env });
      commit = git(['commit-tree', treeId, '-p', tree.head, '-m', `Developer Mode work, saved ${at} when Developer Mode was switched off`], { env });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  git(['branch', branch, commit]);

  // `main`'s own work, if another branch was checked out: kept on a branch too.
  let mainBranch: string | undefined;
  const main = tryGit(['rev-parse', '--verify', '-q', 'refs/heads/main']);
  if (tree.branch !== 'main' && main && lines(tryGit(['rev-list', `${release.commit}..${main}`])).length > 0
    && tryGit(['merge-base', '--is-ancestor', main, commit]) === null) {
    mainBranch = `${branch}-main`;
    git(['branch', mainBranch, main]);
  }

  // The backup, before anything is reset.
  const backup = join(devBackupsDir(), at);
  exportPatches(join(backup, 'patches'));
  git(['bundle', 'create', join(backup, 'dev.bundle'), branch, ...(mainBranch ? [mainBranch] : []), `^${release.commit}`]);
  pruneDevBackups(now);

  // Reset: `main` at the release, checked out; the work is on the branch.
  git(['checkout', '-f', '-B', 'main', release.commit]);
  git(['clean', '-fd']);
  return { branch, commit, ...(mainBranch ? { mainBranch } : {}), backup, release };
}

/** The owner's git identity when set, else AuraOS (commit-tree needs one). */
function identityEnv(): Record<string, string> {
  if (tryGit(['config', 'user.email'])) return {};
  return {
    GIT_AUTHOR_NAME: 'AuraOS', GIT_AUTHOR_EMAIL: 'aura@localhost',
    GIT_COMMITTER_NAME: 'AuraOS', GIT_COMMITTER_EMAIL: 'aura@localhost',
  };
}

/** Drop automatic clean-up backups older than DEV_BACKUP_DAYS. Never throws. */
export function pruneDevBackups(now = new Date()): string[] {
  const removed: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(devBackupsDir()); } catch { return removed; }
  const cutoff = now.getTime() - DEV_BACKUP_DAYS * 24 * 60 * 60 * 1000;
  for (const n of names) {
    const p = join(devBackupsDir(), n);
    try {
      if (statSync(p).mtimeMs < cutoff) { rmSync(p, { recursive: true, force: true }); removed.push(n); }
    } catch { /* gone or unreadable */ }
  }
  return removed;
}
