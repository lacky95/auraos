/**
 * Submit an app to a curated store index by opening a pull request.
 *
 * Publishing an app and listing it are two different acts against two
 * different repositories: `publishGit` pushes the app to the author's own repo,
 * and this proposes a one-file change to the store's. Doing the second by hand
 * — write the entry, npm ci, regenerate the index, branch, commit, push, open a
 * PR, fill the template — is a dozen mechanical steps derivable entirely from
 * the manifest and the publish that just happened.
 *
 * ── Why it runs the store's own scripts ─────────────────────────────────
 * The store commits its generated `index.yaml`/`index.json` and its CI
 * byte-compares them (`build-index.mjs --check`). Any reimplementation here
 * would have to reproduce that output exactly — key order, YAML style, the
 * header comment's app count — and would silently rot the first time the store
 * changed its generator. So we clone the store, `npm ci`, and run ITS
 * `build-index.mjs`. Slower, and correct by construction.
 *
 * ── Phases ──────────────────────────────────────────────────────────────
 * 0. map      — pure, no network, no token. Bad metadata fails here, before
 *               anything is created anywhere.
 * 1. local    — clone/refresh, write entry, regenerate index, validate. Needs
 *               no token for a public store, which is what makes `--dry-run`
 *               useful to someone who has not set one up yet.
 * 2. github   — branch, push, open or update the PR.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import type { AppManifest } from '../types/manifest.js';
import {
  buildStoreEntry, renderEntryYaml, mergeEntry,
  type EntryProblem, type StoreEntry, type StoreEntryCtx,
} from './StoreEntry.js';
import { GitHubClient, GitHubError, parseRepoSlug } from './GitHubClient.js';
import {
  identifyImage, assetPath, assetUrl, isOwnAsset, MAX_SCREENSHOTS,
} from './StoreAssets.js';

export interface SubmitOpts {
  manifest: AppManifest;
  /** Where the app was published — feeds sources/channels in the entry. */
  entryCtx: StoreEntryCtx;
  /** `owner/repo` of the store index repository. */
  storeRepo: string;
  /** Resolved GitHub token. Not needed when `dryRun` and the store is public. */
  token?: string;
  /** AuraOS data dir; the clone is cached beneath it. */
  dataDir: string;
  /** Stop after phase 1 and report what would happen. */
  dryRun?: boolean;
  /** Replace the descriptive fields of an existing entry, not just the channel. */
  updateMetadata?: boolean;
  /** Skip the CODEOWNERS line. */
  noCodeowners?: boolean;
  /** Overwrite a submission branch a human has edited. */
  force?: boolean;
  /** The author attested namespace ownership and having read the policy. */
  acceptPolicy?: boolean;
  onMessage?: (m: string) => void;
}

export interface SubmitResult {
  problems:   EntryProblem[];
  entry:      StoreEntry;
  entryYaml:  string;
  /** 'create' on a first submission, 'update' on a version/metadata change. */
  change:     'create' | 'update';
  branch:     string;
  /** Unset on a dry run, or when nothing changed. */
  prUrl?:     string;
  /** True when the branch already matched — nothing was pushed. */
  unchanged?: boolean;
  mode?:      'owner' | 'fork';
  diffStat?:  string;
}

export class SubmitError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message); this.name = 'SubmitError';
  }
}

/** Run git with the token supplied out-of-band.
 *
 *  Never in the remote URL and never in `.git/config` — the clone is cached
 *  under /data and would keep the credential on disk. Never in argv either,
 *  where `ps` would show it. `GIT_CONFIG_COUNT` injects an http.extraheader for
 *  one invocation only; this is the mechanism actions/checkout uses. */
function gitEnv(token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    env['GIT_CONFIG_COUNT']   = '1';
    env['GIT_CONFIG_KEY_0']   = 'http.https://github.com/.extraheader';
    env['GIT_CONFIG_VALUE_0'] = `Authorization: Basic ${basic}`;
  }
  return env;
}

function git(cwd: string, args: string[], token?: string, timeout = 120_000): string {
  return execFileSync('git', args, {
    cwd, env: gitEnv(token), stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8', timeout,
  }).toString();
}

function run(cwd: string, cmd: string, args: string[], timeout = 300_000): string {
  return execFileSync(cmd, args, {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout,
  }).toString();
}

export async function submitToStore(opts: SubmitOpts): Promise<SubmitResult> {
  const log = (m: string) => opts.onMessage?.(m);
  const { owner, repo } = parseRepoSlug(opts.storeRepo);

  // ── Phase 0: map ───────────────────────────────────────────────────────
  log('mapping manifest to a store entry...');
  const { entry: fresh, problems } = buildStoreEntry(opts.manifest, opts.entryCtx);
  const errors = problems.filter((p) => p.severity === 'error');
  if (errors.length) {
    throw new SubmitError(
      `the manifest cannot be listed as-is:\n`
      + errors.map((e) => `  ${e.field}: ${e.message}`).join('\n'),
      'Nothing was created. Fix app.manifest.json and run `aura nexus app submit` again — '
      + 'the app is already published, so there is no need to re-publish.',
    );
  }

  // ── Phase 1: local clone + index ───────────────────────────────────────
  const branch = `nexus/submit/${opts.manifest.id}-v${opts.manifest.version}`;
  const { cloneDir } = openClone({ owner, repo, dataDir: opts.dataDir, token: opts.token, branch, log });

  const entryPath = join(cloneDir, 'apps', `${opts.manifest.id}.yaml`);
  const existed = existsSync(entryPath);
  let entry = fresh;
  if (existed) {
    try {
      const prev = parse(readFileSync(entryPath, 'utf8')) as StoreEntry;
      entry = mergeEntry(prev, fresh, opts.updateMetadata ? 'full' : 'channel');
    } catch {
      log('  existing entry could not be parsed — replacing it');
    }
  }
  const entryYaml = renderEntryYaml(entry);
  mkdirSync(dirname(entryPath), { recursive: true });
  writeFileSync(entryPath, entryYaml);
  log(`  ${existed ? 'updated' : 'created'} apps/${opts.manifest.id}.yaml`);

  if (!opts.noCodeowners && opts.token) {
    // Best effort: needs the login, which needs the token.
    try {
      const login = await new GitHubClient(opts.token).whoami();
      addCodeowner(cloneDir, opts.manifest.id, login, log);
    } catch { /* not fatal — a maintainer can add it */ }
  }

  const change: 'create' | 'update' = existed ? 'update' : 'create';
  const title = change === 'create'
    ? `Add ${opts.manifest.id}`
    : `Update ${opts.manifest.id} to ${opts.manifest.version}`;

  const out = await buildAndOpenPr({
    owner, repo, cloneDir, branch, title,
    body: () => renderPrBody(opts, entry, problems, change),
    token: opts.token, dryRun: opts.dryRun, force: opts.force, log,
    nothingChangedNote: 'the store already lists this exact entry',
  });

  return { problems, entry, entryYaml, change, branch, ...out };
}


// ─── screenshots ────────────────────────────────────────────────────────────

export interface ScreenshotOpts {
  appId:     string;
  action:    'list' | 'add' | 'remove' | 'replace';
  /** add / replace: a local file path, or an absolute https URL. */
  source?:   string;
  /** remove / replace: 1-based position, as printed by `list`. */
  index?:    number;
  storeRepo: string;
  /** The store's index URL — assets are served from its origin. */
  indexUrl:  string;
  token?:    string;
  dataDir:   string;
  dryRun?:   boolean;
  force?:    boolean;
  onMessage?: (m: string) => void;
}

export interface ScreenshotResult {
  appId:       string;
  /** The list AFTER the operation (or the current list, for `list`). */
  screenshots: string[];
  /** Set when a local file was uploaded into the store repo. */
  uploaded?:   { path: string; url: string; bytes: number };
  /** Set when removing dropped an asset this store was hosting. */
  deleted?:    string;
  branch?:     string;
  prUrl?:      string;
  unchanged?:  boolean;
  mode?:       'owner' | 'fork';
  diffStat?:   string;
}

/**
 * Add, replace, remove or list the screenshots on an existing listing.
 *
 * Deliberately separate from `submitToStore`: pictures change on their own
 * schedule, and routing them through a version bump would mean either
 * re-publishing an app that has not changed, or using --update-metadata and
 * overwriting a description a maintainer edited during review.
 *
 * The PR it opens touches exactly the entry's `screenshots` (plus the image
 * itself, when one is uploaded), so it is reviewable at a glance.
 */
export async function manageScreenshots(opts: ScreenshotOpts): Promise<ScreenshotResult> {
  const log = (m: string) => opts.onMessage?.(m);
  const { owner, repo } = parseRepoSlug(opts.storeRepo);

  const branch = `nexus/shots/${opts.appId}`;
  const { cloneDir } = openClone({
    owner, repo, dataDir: opts.dataDir, token: opts.token, branch, log,
  });

  const entryPath = join(cloneDir, 'apps', `${opts.appId}.yaml`);
  if (!existsSync(entryPath)) {
    throw new SubmitError(
      `${opts.appId} is not listed in ${opts.storeRepo}`,
      'Screenshots attach to an existing listing. Submit the app first with `aura nexus app submit`.',
    );
  }
  const entry = parse(readFileSync(entryPath, 'utf8')) as StoreEntry;
  const shots: string[] = Array.isArray(entry.screenshots) ? entry.screenshots.slice() : [];

  if (opts.action === 'list') {
    return { appId: opts.appId, screenshots: shots };
  }

  // 1-based on the wire because that is what `list` prints; a user typing the
  // number they can see should not have to subtract one.
  const at = (opts.index ?? 0) - 1;
  const needsIndex = opts.action === 'remove' || opts.action === 'replace';
  if (needsIndex && (at < 0 || at >= shots.length)) {
    throw new SubmitError(
      `there is no screenshot ${opts.index} — the listing has ${shots.length}`,
      'Run `aura nexus app screenshots list` to see the current numbering.',
    );
  }

  let uploaded: ScreenshotResult['uploaded'];
  let deleted: string | undefined;

  /** Resolve `source` to a URL, uploading a local file when that is what it is. */
  const resolveSource = (): string => {
    const src = (opts.source ?? '').trim();
    if (!src) throw new SubmitError('no image given', 'Pass a file path or an https:// URL.');
    if (/^https:\/\//i.test(src)) return src;
    if (/^http:\/\//i.test(src)) {
      throw new SubmitError(`${src} must be https`, 'The store only lists images served over https.');
    }
    if (!existsSync(src)) {
      throw new SubmitError(`no such file: ${src}`,
        'Pass a path this OS can see, or an https:// URL. Publishing runs inside the '
        + 'AuraOS container, so a path from your host may not resolve here.');
    }
    const buf  = readFileSync(src);
    const info = identifyImage(buf);           // throws on non-images and oversize
    const rel  = assetPath(opts.appId, info);
    const url  = assetUrl(opts.indexUrl, opts.appId, info);
    const dest = join(cloneDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    uploaded = { path: rel, url, bytes: info.bytes };
    log(`  added ${rel} (${(info.bytes / 1024).toFixed(0)} kB) — served at ${url}`);
    return url;
  };

  /** Drop an asset file when nothing references it any more. Only ever touches
   *  images this store hosts; a URL pointing elsewhere is not ours to delete. */
  const gcAsset = (url: string, keep: string[]) => {
    if (!isOwnAsset(url, opts.indexUrl, opts.appId)) return;
    if (keep.includes(url)) return;
    const rel = url.slice(new URL(opts.indexUrl).origin.length + 1);
    const abs = join(cloneDir, rel);
    if (existsSync(abs)) { rmSync(abs); deleted = rel; log(`  removed ${rel}`); }
  };

  if (opts.action === 'add') {
    if (shots.length >= MAX_SCREENSHOTS) {
      throw new SubmitError(
        `the listing already has ${shots.length} screenshots, the store allows ${MAX_SCREENSHOTS}`,
        'Remove one first with `aura nexus app screenshots remove <n>`.',
      );
    }
    const url = resolveSource();
    if (shots.includes(url)) {
      // Content-addressed names mean re-adding the same picture lands on the
      // same URL; saying so is better than silently duplicating it.
      log('  that image is already listed — nothing to do');
      return { appId: opts.appId, screenshots: shots, unchanged: true };
    }
    shots.push(url);
  } else if (opts.action === 'remove') {
    const [gone] = shots.splice(at, 1);
    if (gone) gcAsset(gone, shots);
  } else {
    const url = resolveSource();
    const [gone] = shots.splice(at, 1, url);
    if (gone) gcAsset(gone, shots);
  }

  if (shots.length) entry.screenshots = shots;
  else delete entry.screenshots;
  writeFileSync(entryPath, renderEntryYaml(entry));

  const verb = opts.action === 'add' ? 'Add a screenshot to'
    : opts.action === 'remove' ? 'Remove a screenshot from'
    : 'Replace a screenshot in';
  const title = `${verb} ${opts.appId}`;

  const out = await buildAndOpenPr({
    owner, repo, cloneDir, branch, title,
    body: () => [
      `## What is this app?`, '',
      `A screenshot change for \`${opts.appId}\` — no version change, no new code.`, '',
      '## Checklist', '',
      `- [x] \`apps/<id>.yaml\` — the filename matches the \`id\``,
      `- [x] The \`id\` matches the \`id\` in the app's \`app.manifest.json\``,
      `- [x] \`node scripts/validate.mjs --no-network\` passes (run before this PR was opened)`,
      `- [x] Screenshots are absolute \`https://\` URLs`,
      '', '## Capabilities', '',
      '- None. This changes listing images only; the app, its source and its',
      '  permissions are untouched.',
      '', '## Type of change', '', '- [x] Metadata update',
      '', '---', '',
      `Screenshots now (${shots.length}):`, '',
      ...shots.map((u, i) => `${i + 1}. ${u}`),
      ...(uploaded ? ['', `Uploaded \`${uploaded.path}\` (${(uploaded.bytes / 1024).toFixed(0)} kB).`] : []),
      ...(deleted ? [`Deleted \`${deleted}\`, no longer referenced.`] : []),
      '', 'Opened by `aura nexus app screenshots` from AuraOS.',
    ].join('\n'),
    token: opts.token, dryRun: opts.dryRun, force: opts.force, log,
    nothingChangedNote: 'the listing already has exactly these screenshots',
  });

  return { appId: opts.appId, screenshots: shots, uploaded, deleted, branch, ...out };
}

/**
 * Clone the store (or refresh a cached clone) and cut a submission branch.
 *
 * The clone is cached under the data dir and reused: re-runs are then a fetch
 * rather than a full clone, and node_modules stays warm across submissions.
 * The branch is ALWAYS recut from upstream, so it is fully derived from the
 * current index — no drift, no conflicts, and a re-run after someone else's
 * merge cannot carry their changes back as a revert.
 */
function openClone(o: {
  owner: string; repo: string; dataDir: string; token?: string;
  branch: string; log: (m: string) => void;
}): { cloneDir: string; defaultBranch: string } {
  const cloneDir = join(o.dataDir, 'nexus', 'store-submit', `${o.owner}-${o.repo}`);
  const upstream = `https://github.com/${o.owner}/${o.repo}.git`;

  if (existsSync(join(cloneDir, '.git'))) {
    o.log('refreshing the store clone...');
    git(cloneDir, ['remote', 'set-url', 'origin', upstream], o.token);
    git(cloneDir, ['fetch', 'origin', '--prune'], o.token);
  } else {
    o.log(`cloning ${o.owner}/${o.repo}...`);
    rmSync(cloneDir, { recursive: true, force: true });
    mkdirSync(dirname(cloneDir), { recursive: true });
    git(dirname(cloneDir), ['clone', upstream, cloneDir], o.token, 180_000);
  }

  const defaultBranch = git(cloneDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], o.token)
    .trim().replace(/^origin\//, '') || 'main';

  git(cloneDir, ['checkout', '-B', o.branch, `origin/${defaultBranch}`], o.token);
  // `checkout -B` does NOT discard uncommitted work, so a cached clone carries
  // the last run's edits into the next one — a dry run would silently poison
  // the real run that followed it, which is exactly how this was found. Reset
  // hard and clean so the branch really is derived from upstream alone.
  // `clean -fd` without -x deliberately spares ignored paths: node_modules is
  // the reason the clone is cached at all.
  git(cloneDir, ['reset', '--hard', `origin/${defaultBranch}`], o.token);
  git(cloneDir, ['clean', '-fd'], o.token);
  return { cloneDir, defaultBranch };
}

/**
 * Regenerate the index, validate, then commit, push and open or update the PR.
 *
 * Shared by every kind of store change, so a screenshot edit and a new listing
 * cannot drift apart in how they are proposed — same branch discipline, same
 * fork handling, same idempotency.
 */
async function buildAndOpenPr(o: {
  owner: string; repo: string; cloneDir: string; branch: string;
  title: string; body: () => string;
  token?: string; dryRun?: boolean; force?: boolean;
  log: (m: string) => void; nothingChangedNote: string;
}): Promise<{ prUrl?: string; unchanged?: boolean; mode?: 'owner' | 'fork'; diffStat?: string }> {
  const { cloneDir, owner, repo, branch, log } = o;

  // The store's own toolchain. `yaml`/`ajv` are devDependencies, so a
  // production-only install would leave the scripts unable to run.
  // --ignore-scripts because this executes code from a repo the caller named.
  log('installing the store toolchain...');
  try {
    run(cloneDir, 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  } catch {
    run(cloneDir, 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
  }

  log('regenerating the index...');
  runStoreScript(cloneDir, 'scripts/build-index.mjs', []);
  log('validating...');
  runStoreScript(cloneDir, 'scripts/validate.mjs', ['--no-network']);
  // Self-assert: what CI will run.
  runStoreScript(cloneDir, 'scripts/build-index.mjs', ['--check']);

  git(cloneDir, ['add', '-A'], o.token);
  const diffStat = git(cloneDir, ['diff', '--cached', '--stat'], o.token).trim();

  if (!diffStat) {
    log(`nothing changed — ${o.nothingChangedNote}`);
    return { unchanged: true };
  }
  if (o.dryRun) {
    log('dry run — stopping before GitHub');
    return { diffStat };
  }

  if (!o.token) {
    throw new SubmitError('a GitHub token is required to open a pull request',
      'Run `gh auth login`, or store one with `aura nexus store login`.');
  }
  const gh = new GitHubClient(o.token);
  const info = await gh.repoInfo(owner, repo);
  const login = await gh.whoami();
  const mode: 'owner' | 'fork' = info.canPush ? 'owner' : 'fork';
  log(`submitting as ${login} (${mode} mode)`);

  git(cloneDir, ['-c', 'user.name=AuraOS Nexus', '-c', 'user.email=nexus@aura.local',
    'commit', '-m', o.title], o.token);

  let pushRemote = 'origin';
  if (mode === 'fork') {
    log('forking the store...');
    await gh.ensureFork(owner, repo, login);
    // Branch from UPSTREAM but push to the fork: a stale fork would otherwise
    // turn the PR into a pile of unrelated reverts.
    const forkUrl = `https://github.com/${login}/${repo}.git`;
    try { git(cloneDir, ['remote', 'add', 'fork', forkUrl], o.token); }
    catch { git(cloneDir, ['remote', 'set-url', 'fork', forkUrl], o.token); }
    pushRemote = 'fork';
  }

  log('pushing the branch...');
  try {
    git(cloneDir, ['push', '--force-with-lease', pushRemote, `HEAD:refs/heads/${branch}`],
      o.token, 180_000);
  } catch (err) {
    const msg = String((err as { stderr?: Buffer }).stderr ?? (err as Error).message);
    if (!o.force && /stale info|rejected/i.test(msg)) {
      throw new SubmitError(
        `the branch ${branch} has been modified on the remote`,
        'Someone edited it after the last run. Re-run with --force to overwrite it.',
      );
    }
    if (o.force) {
      git(cloneDir, ['push', '--force', pushRemote, `HEAD:refs/heads/${branch}`], o.token, 180_000);
    } else throw err;
  }

  const head = `${mode === 'fork' ? login : owner}:${branch}`;
  const existing = await gh.findOpenPr(owner, repo, head);
  const pr = existing
    ? await gh.updatePr(owner, repo, existing.number, { title: o.title, body: o.body() })
    : await gh.createPr(owner, repo, { title: o.title, body: o.body(), head, base: info.defaultBranch });

  log(existing ? `updated PR #${pr.number}` : `opened PR #${pr.number}`);
  return { prUrl: pr.html_url, mode, diffStat };
}

/** Run one of the store's scripts, surfacing its output verbatim on failure —
 *  those messages are already precisely worded and re-wording them loses
 *  information the author needs. */
function runStoreScript(cwd: string, script: string, args: string[]): void {
  if (!existsSync(join(cwd, script))) {
    throw new SubmitError(`${script} not found in the store repo`,
      'This does not look like an AuraOS store index repository.');
  }
  try {
    run(cwd, process.execPath, [script, ...args]);
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
    throw new SubmitError(`${script} failed:\n${out}`);
  }
}

/** Add `/apps/<id>.yaml  @login` to CODEOWNERS, sorted by path — closing the
 *  ownership gap the store documents but never enforced. */
function addCodeowner(cloneDir: string, id: string, login: string, log: (m: string) => void): void {
  const p = join(cloneDir, '.github', 'CODEOWNERS');
  if (!existsSync(p)) return;
  const line = `/apps/${id}.yaml   @${login}`;
  const text = readFileSync(p, 'utf8');
  if (text.includes(`/apps/${id}.yaml`)) return;
  const lines = text.trimEnd().split('\n');
  const entries = lines.filter((l) => l.startsWith('/apps/') && l.includes('.yaml'));
  const rest    = lines.filter((l) => !(l.startsWith('/apps/') && l.includes('.yaml')));
  entries.push(line);
  entries.sort();
  writeFileSync(p, `${[...rest, ...entries].join('\n')}\n`);
  log(`  claimed /apps/${id}.yaml for @${login} in CODEOWNERS`);
}

/**
 * Fill the store's PR template. Boxes are ticked ONLY for what was actually
 * verified here; the two author attestations stay unticked unless the author
 * made them, because a tool checking them on their behalf would launder a
 * claim it cannot make.
 */
function renderPrBody(
  opts: SubmitOpts, entry: StoreEntry, problems: EntryProblem[], change: 'create' | 'update',
): string {
  const m = opts.manifest;
  const attested = opts.acceptPolicy === true;
  const box = (on: boolean) => (on ? '[x]' : '[ ]');

  const risky = (m.tools ?? []).filter((t) => t === 'docker' || t === '*');
  const provider = (m as { dataProvider?: { authority?: string } }).dataProvider?.authority;
  const caps: string[] = [];
  if (risky.length) {
    caps.push(`Requests privileged tools: \`${risky.join('`, `')}\` — `
      + '`docker` is host root via the socket; `*` grants every tool.');
  }
  if (provider) caps.push(`Declares a dataProvider authority \`${provider}\` — readable by other apps.`);
  if ((m.tools ?? []).length) caps.push(`Full tools list: \`${(m.tools ?? []).join('`, `')}\`.`);
  if (!caps.length) caps.push('None. No privileged tools, no dataProvider.');

  const warns = problems.filter((p) => p.severity === 'warn');

  return [
    '## What is this app?',
    '',
    entry.description ?? m.description ?? '_No description in the manifest._',
    '',
    `Published from \`${entry.sources.git?.ref ?? entry.sources.oci?.ref ?? '?'}\`.`,
    '',
    '## Checklist',
    '',
    `- ${box(true)} \`apps/<id>.yaml\` — the filename matches the \`id\``,
    `- ${box(true)} The \`id\` matches the \`id\` in the app's \`app.manifest.json\``,
    `- ${box(attested)} I control this reverse-domain namespace (or the repository it names)`
      + (attested ? '' : ' _(not attested — submitted non-interactively)_'),
    `- ${box(true)} \`node scripts/validate.mjs --no-network\` passes (run before this PR was opened)`,
    `- ${box(false)} The source is public and the channel tags exist _(CI runs the network check)_`,
    `- ${box(true)} Icon is a 1–3 character glyph`,
    `- ${box(true)} Screenshots are absolute \`https://\` URLs`,
    `- ${box(attested)} I have read POLICY.md`
      + (attested ? '' : ' _(not attested — submitted non-interactively)_'),
    '',
    '## Capabilities',
    '',
    ...caps.map((c) => `- ${c}`),
    '',
    '## Type of change',
    '',
    `- ${box(change === 'create')} New app`,
    `- ${box(change === 'update')} Version bump (channel tag change)`,
    `- ${box(false)} Metadata update`,
    `- ${box(false)} Removing my app`,
    ...(warns.length ? ['', '## Notes from the generator', '',
      ...warns.map((w) => `- \`${w.field}\`: ${w.message}`)] : []),
    '',
    '---',
    '',
    `Opened by \`aura nexus app submit\` from AuraOS.`,
  ].join('\n');
}
