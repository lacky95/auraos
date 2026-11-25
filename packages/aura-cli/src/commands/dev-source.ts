/**
 * Where an app's source is, and the author side of it (Track P).
 *
 *   aura dev status [app]          the installation, its mode, base, patches,
 *                                  source view and workspace, and the next step
 *   aura dev open <app>            open an installed copy for direct development
 *                                  (owner approval), `--close` to close it again
 *   aura dev publish --repo <url>  push this repo's history, record `repository`,
 *                                  then publish a release (`nexus app publish`)
 *
 * The system knows only the source mode, the read-only rule and how to bind
 * and install trees (routes in aura-work/trackp-streams.md "## Routes":
 * R1 app-source, R2 app-workspace, R3 source-mode, R4 activate). Everything
 * else — the patch repo, workspaces' content, series — is here and in
 * dev-patch.ts. Git runs in this process: the Terminal, where the user's
 * credentials are.
 */
import type { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  initRepo, patchesOverride, readSeries, safeDirectoryArgs, SYSTEM_APP_LATER_MESSAGE, SYSTEM_APP_OVERLAYS, type SeriesBase,
} from '@aura/core';
import { api } from '../lib/client.js';
import { color, fail, info, ok, warn } from '../lib/format.js';

// ─── system routes (P-SYS) ──────────────────────────────────────────────────

/** R1: what the system knows about an app's source, for this caller. */
export interface AppSourceView {
  appId:                string;
  name:                 string;
  version:              string;
  scope:                'system' | 'global' | 'user';
  /** The patch key (a system-app overlay: the system app's installation). */
  installationId:       string;
  activeInstallationId: string;
  overlay:              boolean;
  mode:                 'closed' | 'open';
  defaultMode:          'closed' | 'open';
  modeFrom:             'system' | 'local' | 'record' | 'checkout' | 'manifest' | 'default';
  upstream:             { repository?: string; branch?: string; commit?: string; dirty?: boolean } | null;
  source:               { path: string; writable: boolean; mounted: boolean };
  workspace:            { n: number; path: string } | null;
  /** The installation's patch repo: /mnt/aura/patches/<appId>, and whether it is bound here. */
  patches?:             { path: string; mounted: boolean };
  workspaces:           number[];
  /** The user the caller acts for (workspaces are per user). */
  user?:                string;
  next:                 string;
}

export interface WorkspaceBind { ok: true; appId: string; installationId: string; n: number; path: string; created: boolean }

export interface WorkspaceClean {
  ok: true; appId: string; installationId: string;
  kept: number[]; candidates: number[]; inUse: number[]; deleted: number[]; detached: number;
}

/** The calling instance: routes bind into it, so only itself (or the owner) may ask. */
export function callerInstance(): string {
  const id = process.env['APP_INSTANCE_ID'] ?? process.env['AURA_INSTANCE_ID'];
  if (!id) fail('this needs to run in an AuraOS Terminal (no $APP_INSTANCE_ID): the source view and workspaces are bound into the calling instance');
  return id;
}

/** Admin-style routes answer errors with a JSON body; surface it instead of throwing. */
export async function apiOrBody<T>(call: () => Promise<unknown>): Promise<T> {
  try {
    return await call() as T;
  } catch (err) {
    const raw = (err as { body?: string }).body;
    if (raw) { try { return JSON.parse(raw) as T; } catch { /* not JSON */ } }
    throw err;
  }
}

type RouteError = { error?: string; message?: string; matches?: string[] };

function routeFail(what: string, r: RouteError): never {
  if (r.error === 'ambiguous-app') fail(`${what}: more than one app matches — name one of: ${(r.matches ?? []).join(', ')}`);
  if (r.error === 'app-not-found') fail(`${what}: no such app (use its id or exact name; \`aura get apps\` lists them)`);
  fail(`${what}: ${r.message ?? r.error ?? 'failed'}`);
}

/** R1. `ensure`: also make sure the source view is bound in this Terminal. */
export async function getAppSource(app: string, opts: { ensure?: boolean } = {}): Promise<AppSourceView> {
  const inst = encodeURIComponent(callerInstance());
  const r = await apiOrBody<AppSourceView & RouteError>(() => opts.ensure
    ? api.post(`/api/instances/${inst}/app-source`, { app })
    : api.get(`/api/instances/${inst}/app-source?app=${encodeURIComponent(app)}`));
  if (r.error) routeFail(app, r);
  return r;
}

/** The mount API (`aura mount`), kinds `work` and `patches`: the one way they are bound. */
async function mountVolume<T>(app: string, body: Record<string, unknown>, what: string): Promise<T> {
  const inst = encodeURIComponent(callerInstance());
  const r = await apiOrBody<T & RouteError>(() => api.post(`/api/instances/${inst}/mounts`, { targetAppId: app, ...body }));
  if (r.error) routeFail(`${what} of ${app}`, r);
  return r;
}

/** `aura mount <app> --work [n]`: create (if missing) and bind a workspace of `app` at /mnt/aura/work/<appId>. */
export function bindWorkspace(app: string, opts: { n?: number; new?: boolean } = {}): Promise<WorkspaceBind> {
  return mountVolume<WorkspaceBind>(app, {
    kind: 'work', ...(opts.n !== undefined ? { n: opts.n } : {}), ...(opts.new ? { new: true } : {}),
  }, 'workspace');
}

/** `aura mount <app> --patches`: bind the installation's patch repo at /mnt/aura/patches/<appId>. */
export function bindPatchRepo(app: string): Promise<{ ok: true; appId: string; installationId: string; path: string; created: boolean }> {
  return mountVolume(app, { kind: 'patches' }, 'patch repository');
}

/** `aura mount rm <appId>:work`: detach the workspace of `app` bound here (its directory stays). */
export async function detachWorkspace(app: string): Promise<void> {
  const inst = encodeURIComponent(callerInstance());
  await api.del(`/api/instances/${inst}/mounts/${encodeURIComponent(`${app}:work`)}`);
}

/**
 * R2c: old workspaces of `app` (this user, this installation). `dryRun`: only
 * the candidates and which are in use elsewhere; `delete`: just these;
 * `force`: in-use ones too.
 */
export async function cleanWorkspaces(app: string, opts: { keep?: number; dryRun?: boolean; delete?: number[]; force?: boolean } = {}): Promise<WorkspaceClean> {
  const inst = encodeURIComponent(callerInstance());
  const r = await apiOrBody<WorkspaceClean & RouteError>(() => api.post(`/api/instances/${inst}/app-workspace/clean`, {
    app, ...(opts.keep !== undefined ? { keep: opts.keep } : {}), ...(opts.dryRun ? { dryRun: true } : {}),
    ...(opts.delete ? { delete: opts.delete } : {}), ...(opts.force ? { force: true } : {}),
  }));
  if (r.error) routeFail(`clean workspaces of ${app}`, r);
  return r;
}

/** A built-in app (system scope, or an overlay of one): not patched in Track P v1 (core SYSTEM_APP_OVERLAYS). */
export function isBuiltInLater(v: Pick<AppSourceView, 'scope' | 'overlay'>): boolean {
  return (v.scope === 'system' || v.overlay) && !SYSTEM_APP_OVERLAYS;
}

/** Stop a patch command on a built-in app, with the reason. */
export function refuseBuiltIn(v: Pick<AppSourceView, 'appId' | 'scope' | 'overlay'>): void {
  if (isBuiltInLater(v)) fail(`${v.appId} is a built-in app. ${SYSTEM_APP_LATER_MESSAGE}.`);
}

// ─── where things are ───────────────────────────────────────────────────────

/** What a workspace remembers about itself, in `.git/` (never part of a patch). */
export interface WorkspaceMarker {
  appId:          string;
  installationId: string;
  n:              number;
  /** The upstream base (real commit) the workspace was made from. */
  base:           SeriesBase;
  /** The local commit the patches start after (differs from base.commit for a `path` base). */
  baseCommit:     string;
  /** Patch repo revision applied when the workspace was made or last saved. */
  patchesRev:     string | null;
  /** The build workspace activate and update reuse (never edited, never saved from). */
  scratch?:       true;
}

export const WORKSPACE_MARKER = 'aura-workspace.json';

export function readWorkspaceMarker(ws: string): WorkspaceMarker | null {
  try { return JSON.parse(readFileSync(join(ws, '.git', WORKSPACE_MARKER), 'utf-8')) as WorkspaceMarker; }
  catch { return null; }
}

export function writeWorkspaceMarker(ws: string, m: WorkspaceMarker): void {
  writeFileSync(join(ws, '.git', WORKSPACE_MARKER), JSON.stringify(m, null, 2) + '\n');
}

/** Walk up from `dir` to a patch workspace (its root and marker), if inside one. */
export function findWorkspace(dir: string): { root: string; marker: WorkspaceMarker } | null {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const marker = readWorkspaceMarker(d);
    if (marker) return { root: d, marker };
    if (dirname(d) === d) return null;
  }
}

/** Walk up from `dir` to the nearest app root (a dir with app.manifest.json). */
export function findAppRoot(dir: string): { root: string; appId: string } | null {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const m = join(d, 'app.manifest.json');
    if (existsSync(m)) {
      try {
        const id = (JSON.parse(readFileSync(m, 'utf-8')) as { id?: unknown }).id;
        if (typeof id === 'string' && id) return { root: d, appId: id };
      } catch { /* keep walking */ }
    }
    if (dirname(d) === d) return null;
  }
}

/** The app a command is about: the argument, else the workspace or app dir we are in. */
export function appFromArgOrCwd(app: string | undefined, cwd = process.cwd()): string {
  if (app) return app;
  const ws = findWorkspace(cwd);
  if (ws) return ws.marker.appId;
  const root = findAppRoot(cwd);
  if (root) return root.appId;
  fail('name the app (id or name), or run this inside its source or patch workspace');
}

/**
 * The installation's patch repo (git; the series is created on the first
 * save): one dir per installation on the app-data volume, bound into this
 * Terminal at /mnt/aura/patches/<appId> (bound here if it is not yet).
 * `AURA_PATCHES_DIR` (tests only) puts it at `<dir>/<installationId>` instead.
 */
export async function patchRepoOf(v: Pick<AppSourceView, 'appId' | 'installationId' | 'patches'>): Promise<string> {
  if (!/^[0-9a-f-]{8,64}$/i.test(v.installationId)) fail(`unexpected installation id '${v.installationId}'`);
  const override = patchesOverride();
  if (override) return join(override, v.installationId);
  if (v.patches?.mounted) return v.patches.path;
  return (await bindPatchRepo(v.appId)).path;
}

/** The patch repo revision that is installed now (set by a successful activate). */
export const ACTIVE_REF = 'refs/aura/active';

export function gitOut(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', [...safeDirectoryArgs(cwd), '-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).toString().trim() || null;
  } catch { return null; }
}

/** The upstream an installed app's patches are based on (system apps: their dir in the AuraOS repo). */
export function upstreamBase(v: AppSourceView): SeriesBase | null {
  const u = v.upstream;
  if (!u?.repository || !u.commit) return null;
  return {
    repository: u.repository,
    commit:     u.commit,
    ...(v.scope === 'system' || v.overlay ? { path: `apps/${v.appId}` } : {}),
  };
}

// ─── dev status ─────────────────────────────────────────────────────────────

export function printStatus(v: AppSourceView, local: { repo: string; head: string | null; active: string | null; patches: number; base: SeriesBase | null }): void {
  const short = (s?: string | null) => (s ? s.slice(0, 12) : color.dim('(none)'));
  console.log(`${color.bold(v.appId)} ${color.dim(`${v.name} ${v.version} · ${v.scope}${v.overlay ? ' (patched overlay of a system app)' : ''}`)}`);
  console.log(`  mode:       ${v.mode === 'open' ? color.green('open') : color.yellow('closed')}  ${color.dim(`(release default: ${v.defaultMode}; from ${v.modeFrom})`)}`);
  console.log(`  source:     ${v.source.path}  ${v.source.mounted ? (v.source.writable ? color.green('writable') : color.dim('read-only')) : color.yellow('not mounted')}`);
  const u = v.upstream;
  console.log(`  upstream:   ${u?.repository ?? color.dim('(no repository)')}${u?.commit ? ` @ ${short(u.commit)}` : ''}${u?.dirty ? color.yellow(' (released with uncommitted changes)') : ''}`);
  if (local.base && local.base.commit !== u?.commit) {
    console.log(`  base:       ${short(local.base.commit)} ${color.yellow('(the saved series is on another commit than the install)')}`);
  }
  console.log(`  patches:    ${local.patches ? `${local.patches} in ${local.repo} @ ${short(local.head)}` : color.dim('(none saved)')}`);
  console.log(`  active:     ${local.active ? short(local.active) : color.dim('(no patches installed)')}${local.active && local.head && local.active !== local.head ? color.yellow('  (saved changes not activated yet)') : ''}`);
  console.log(`  workspace:  ${v.workspace ? v.workspace.path : color.dim(v.workspaces.length ? `(not bound; existing: ${v.workspaces.join(', ')})` : '(none)')}`);
  if (isBuiltInLater(v)) console.log(`  patching:   ${color.yellow(`built-in app — ${SYSTEM_APP_LATER_MESSAGE}`)}`);
  console.log(`  next:       ${v.next}`);
}

function registerDevStatus(dev: Command): void {
  dev
    .command('status [app]')
    .option('--json', 'Print the raw view plus the local patch state')
    .description('Find an app\'s source: mode, base, patches, the read-only source view and workspace paths, and the next step.')
    .addHelpText('after', `
Takes an app id or name, or works from inside the app's source or a patch
workspace. Binds a source view into this Terminal (read-only for closed
installs). Use the paths it prints; never reach app source another way.`)
    .action(async (app: string | undefined, o: { json?: boolean }) => {
      const v = await getAppSource(appFromArgOrCwd(app), { ensure: true });
      const repo = await patchRepoOf(v);
      const hasRepo = existsSync(join(repo, '.git'));
      const series = hasRepo ? safeSeries(repo) : null;
      const local = {
        repo,
        head:    hasRepo ? gitOut(repo, ['rev-parse', 'HEAD']) : null,
        active:  hasRepo ? gitOut(repo, ['rev-parse', '-q', '--verify', ACTIVE_REF]) : null,
        patches: series?.patches.length ?? 0,
        base:    series?.base ?? null,
      };
      if (o.json) { console.log(JSON.stringify({ ...v, patchRepo: local }, null, 2)); return; }
      printStatus(v, local);
    });
}

function safeSeries(repo: string) {
  try { return readSeries(repo); } catch (err) { warn((err as Error).message); return null; }
}

// ─── dev open ───────────────────────────────────────────────────────────────

function registerDevOpen(dev: Command): void {
  dev
    .command('open <app>')
    .option('--close', 'Close it again: its source becomes read-only')
    .description('Open an installed app for direct development (the owner approves), or close it with --close.')
    .addHelpText('after', `
Only when the owner wants this app's installed source edited directly. To
change a closed app, patch it instead: aura dev patch start <app>.`)
    .action(async (app: string, o: { close?: boolean }) => {
      const v = await getAppSource(app);
      const mode = o.close ? 'closed' : 'open';
      if (v.mode === mode) { info(`${v.appId} already is ${mode}`); }
      else {
        // A 202 asks the owner (lib/client.ts), then the same request goes again.
        const r = await apiOrBody<{ ok?: boolean; mode?: string } & RouteError>(
          () => api.post(`/api/apps/${encodeURIComponent(v.appId)}/source-mode`, { mode }));
        if (r.error) routeFail(`${mode} ${v.appId}`, r);
        ok(`${v.appId} is ${mode}`);
      }
      const after = await getAppSource(v.appId, { ensure: true });
      console.log(`  source: ${after.source.path}  ${after.source.writable ? color.green('writable') : color.dim('read-only')}`);
      if (mode === 'open') info(`for a git checkout of its repository: ${color.cyan(`aura dev checkout ${v.appId}`)}`);
    });
}

// ─── dev publish ────────────────────────────────────────────────────────────

/** Set manifest.repository.url in the file's own JSON (keeps key order and indentation). true: changed. */
export function setManifestRepository(appDir: string, url: string): boolean {
  const p = join(appDir, 'app.manifest.json');
  const raw = readFileSync(p, 'utf-8');
  const doc = JSON.parse(raw) as Record<string, unknown>;
  const repo = (doc['repository'] && typeof doc['repository'] === 'object' ? doc['repository'] : {}) as Record<string, unknown>;
  if (repo['url'] === url) return false;
  doc['repository'] = { ...repo, url };
  const indent = /^([ \t]+)"/m.exec(raw)?.[1] ?? '  ';
  writeFileSync(p, JSON.stringify(doc, null, indent) + (raw.endsWith('\n') ? '\n' : ''));
  return true;
}

function git(cwd: string, args: string[], timeout = 60_000): string {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout }).toString().trim();
}

/**
 * The source half of `dev publish`: make sure `appDir` is a repo, record
 * `repository`, set origin and push the branch with its tags. Git runs here,
 * with this Terminal's credentials.
 */
export function pushSource(appDir: string, url: string, log: (m: string) => void = info): { branch: string; commit: string } {
  if (!existsSync(join(appDir, 'app.manifest.json'))) fail(`no app.manifest.json in ${appDir}`);
  if (!existsSync(join(appDir, '.git'))) {
    initRepo(appDir, 'Initial commit');
    log('made it a git repo (git init -b main, one commit)');
  }
  if (setManifestRepository(appDir, url)) {
    git(appDir, ['add', 'app.manifest.json']);
    const id = gitOut(appDir, ['config', 'user.email']) ? [] : ['-c', 'user.name=Aura', '-c', 'user.email=aura@aura.local'];
    git(appDir, [...id, 'commit', '-q', '-m', `Record repository ${url}`]);
    log(`manifest: repository.url = ${url} (committed)`);
  }
  const dirty = gitOut(appDir, ['status', '--porcelain']);
  if (dirty) warn('uncommitted changes are not pushed (the release records the last commit as dirty)');
  if (gitOut(appDir, ['remote', 'get-url', 'origin']) === null) git(appDir, ['remote', 'add', 'origin', url]);
  else git(appDir, ['remote', 'set-url', 'origin', url]);
  const branch = gitOut(appDir, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (!branch) fail('HEAD is detached — check out the branch to publish (e.g. git switch main)');
  try {
    execFileSync('git', ['-C', appDir, 'push', '-u', 'origin', branch!, '--tags'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  } catch (err) {
    const msg = ((err as { stderr?: Buffer }).stderr?.toString() || (err as Error).message).trim().split('\n').slice(-2).join(' ');
    fail(`git push to ${url} failed: ${msg} (log in first, e.g. gh auth login / glab auth login)`);
  }
  const commit = git(appDir, ['rev-parse', 'HEAD']);
  log(`pushed ${branch} @ ${commit.slice(0, 12)} with tags to ${url}`);
  return { branch: branch!, commit };
}

function registerDevPublish(dev: Command): void {
  dev
    .command('publish [path]')
    .requiredOption('--repo <url>',  'Source repo: set as origin, history pushed there, recorded as manifest "repository"')
    .option('--kind <kind>',        'Release kind for `nexus app publish`: oci (default) | git')
    .option('--to <target>',        'Release target (OCI source name / registry URL, or git repo)')
    .option('--tag <tag>',          'Release tag')
    .option('--channel <name>',     'Release channel')
    .option('--no-release',         'Only push the source; publish no release')
    .description('Publish an app you author: push its git history to --repo, record it in the manifest, then publish a release.')
    .action(async (path: string | undefined, o: { repo: string; kind?: string; to?: string; tag?: string; channel?: string; release?: boolean }, cmd: Command) => {
      const appDir = path ? resolve(path) : (findAppRoot(process.cwd())?.root ?? fail('run it in the app\'s directory or pass its path'));
      pushSource(appDir, o.repo);
      if (o.release === false) return;
      // The release is the existing publish, unchanged (`aura nexus app publish`).
      const args = ['nexus', 'app', 'publish', appDir, '--kind', o.kind ?? 'oci', '-y',
        ...(o.to ? ['--to', o.to] : []), ...(o.tag ? ['--tag', o.tag] : []), ...(o.channel ? ['--channel', o.channel] : [])];
      info(`release: aura ${args.join(' ')}`);
      let root: Command = cmd;
      while (root.parent) root = root.parent;
      await root.parseAsync(args, { from: 'user' });
    });
}

export function registerDevSource(dev: Command): void {
  registerDevStatus(dev);
  registerDevOpen(dev);
  registerDevPublish(dev);
}
