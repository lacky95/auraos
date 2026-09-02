/**
 * `aura nexus *` — the AuraOS distribution CLI. Posts to the shell's
 * `/api/nexus/*` endpoints; never touches the filesystem except to read the
 * local manifest being published.
 *
 * Noun-group structure (v2):
 *   aura nexus app publish   [path]  [--to <name|url|repo>] [--kind oci|git]
 *                                    [--tag] [--channel] [--branch] [-y]
 *   aura nexus app install   <ref>   [-y] [--channel] [--scope global|user]
 *   aura nexus app update     [id]   [-y] [--all]
 *   aura nexus app uninstall <id>    [--purge]
 *   aura nexus app list              [--source git|oci|index|local]
 *   aura nexus app info      <ref>
 *   aura nexus registry add  <name> <url> --kind oci|git-index|git-app
 *                                    [--priority] [--mirror] [--ref]
 *   aura nexus registry list
 *   aura nexus registry remove <name>
 *   aura nexus search        [query] [--category] [--refresh]
 *
 * The flat v1 spellings (`aura nexus install`, `aura nexus publish`,
 * `aura nexus registries …`) are kept as HIDDEN aliases so nothing breaks.
 * Bare `aura nexus app publish` (no destination flags, on a TTY) runs an
 * interactive wizard; with flags it's fully non-interactive for CI.
 */
import type { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { api } from '../lib/client.js';
import { color, fail, info, ok, table, warn } from '../lib/format.js';
import {
  BACK, promptChoice, promptConfirm, promptText, PromptCancelled,
} from '../lib/prompts.js';

interface PermissionDiff {
  appId:               string;
  versionFrom:         string | null;
  versionTo:           string;
  toolsAdded:          string[];
  toolsRemoved:        string[];
  permissionsAdded:    string[];
  permissionsRemoved:  string[];
  dataProviderAdded:   boolean;
  dataProviderRemoved: boolean;
  intentFiltersAdded:  string[];
}

interface InstallRecord {
  id:          string;
  version:     string;
  source:      'oci' | 'git' | 'index' | 'local';
  ref:         string;
  digest:      string;
  channel:     string | null;
  installedAt: string;
  updatedAt:   string;
  scope?:      'system' | 'global' | 'user';
}

interface InstallResponse {
  ok:             boolean;
  record?:        InstallRecord;
  needsApproval?: boolean;
  diff?:          PermissionDiff;
  error?:         string;
}

interface InstalledItem {
  manifest: { id: string; name: string; version: string };
  record:   InstallRecord;
  isNexusInstalled: boolean;
}

interface CatalogEntry {
  id:           string;
  name:         string;
  description?: string;
  publisher?:   string;
  categories?:  string[];
  tags?:        string[];
  version?:     string;
  sourceName?:  string;
  sourceKind?:  string;
}

interface SourceEntry {
  kind:     'oci' | 'git-index' | 'git-app';
  name:     string;
  url:      string;
  priority: number;
  mirror?:  boolean;
  ref?:     string;
}

/** Minimal shape of a local app.manifest.json we read for publish. */
interface LocalManifest {
  id:       string;
  name:     string;
  version:  string;
  icon?:    string;
  description?: string;
  category?: string;
  publish?: { repo?: string; registry?: string; channels?: string[] };
  store?: {
    publisher?: string; homepage?: string; license?: string;
    tags?: string[]; longDescription?: string; screenshots?: string[];
  };
}

export function registerNexus(program: Command): void {
  const nexus = program
    .command('nexus')
    .description('Install, update, publish, and discover Aura apps via Nexus.');

  const app = nexus
    .command('app')
    .description('Publish, install, update, and inspect Aura apps.');

  const registry = nexus
    .command('registry')
    .alias('registries')
    .description('Manage the sources Nexus aggregates: OCI registries + git catalogs.');

  // ── app publish ───────────────────────────────────────────────────────────
  wirePublish(app);                       // aura nexus app publish
  wirePublish(nexus, { hidden: true });   // aura nexus publish (legacy alias)

  // ── app submit (open a store PR) ──────────────────────────────────────────
  wireSubmit(app);

  // ── app screenshots ───────────────────────────────────────────────────────
  wireScreenshots(app);

  // ── store credentials ─────────────────────────────────────────────────────
  wireStore(nexus);

  // ── app install / update / uninstall / list / info ────────────────────────
  wireInstall(app);
  wireInstall(nexus, { hidden: true });
  wireUpdate(app);
  wireUpdate(nexus, { hidden: true });
  wireUninstall(app);
  wireUninstall(nexus, { hidden: true });
  wireList(app);
  wireList(nexus, { hidden: true });
  wireInfo(app);
  wireInfo(nexus, { hidden: true });

  // ── search (lives directly under nexus) ───────────────────────────────────
  wireSearch(nexus);

  // ── registry management ───────────────────────────────────────────────────
  wireRegistry(registry);
}

// ─── app publish ────────────────────────────────────────────────────────────
function wirePublish(parent: Command, opts: { hidden?: boolean } = {}): void {
  parent
    .command('publish [path]', { hidden: opts.hidden })
    .description('Publish an app. Bare + interactive → wizard; with flags → non-interactive.')
    .option('--to <target>',     'destination: an OCI source name, registry URL, or git repo')
    .option('--kind <kind>',     'oci or git (default: oci when --to is a source/registry)')
    .option('--source <source>', '[legacy] alias of --kind: git | oci')
    .option('--repo <url>',      '[legacy] git target repo')
    .option('--registry <ref>',  '[legacy] oci target registry (name or URL)')
    .option('--tag <tag>',       'version tag (default: <version> for oci, v<version> for git)')
    .option('--channel <name>',  'channel label (extra tag pushed alongside)')
    .option('--branch <name>',   'git branch (default main)')
    .option('-y, --yes',         'skip the wizard; publish with resolved defaults')
    .option('--submit',          'after publishing, open a pull request listing the app in the store')
    .option('--store-repo <slug>', 'store index repo to submit to (owner/repo)')
    .option('--category <slug>',   'store category, when the manifest category has no store equivalent')
    .option('--accept-policy',     'attest namespace ownership + that you have read POLICY.md')
    .action(async (path: string | undefined, o: {
      to?: string; kind?: string; source?: string; repo?: string; registry?: string;
      tag?: string; channel?: string; branch?: string; yes?: boolean;
      submit?: boolean; storeRepo?: string; category?: string; acceptPolicy?: boolean;
    }) => {
      const appPath = resolve(path ?? '.');
      if (!existsSync(appPath) || !statSync(appPath).isDirectory()) {
        fail(`not a directory: ${appPath}`);
      }
      const manifest = readManifestAt(appPath);
      info(`app: ${color.cyan(manifest.id)} ${manifest.name} v${manifest.version}`);

      // Resolve kind + target from flags (legacy names included).
      let kind: 'oci' | 'git' | undefined =
        (o.kind as 'oci' | 'git' | undefined) ?? (o.source as 'oci' | 'git' | undefined);
      let toTarget = o.to ?? o.registry ?? o.repo;
      let tag = o.tag;
      let channel = o.channel;

      const hasDest = !!(kind || toTarget);
      const interactive = !hasDest && !o.yes && !!process.stdin.isTTY;
      // Set by the wizard's submit step; --submit is the non-interactive form.
      let wantSubmit = false;

      if (interactive) {
        try {
          const plan = await runPublishWizard(appPath, manifest);
          if (!plan) { info('publish cancelled'); return; }
          kind = plan.kind; toTarget = plan.to; tag = plan.tag; channel = plan.channel;
          wantSubmit = plan.submit === true;
        } catch (err) {
          if (err instanceof PromptCancelled) { info('publish cancelled'); return; }
          throw err;
        }
      } else {
        // Non-interactive defaults.
        kind = kind ?? 'oci';
        if (!toTarget) {
          toTarget = kind === 'oci'
            ? (manifest.publish?.registry ?? 'local')
            : (manifest.publish?.repo ?? gitOrigin(appPath) ?? undefined);
        }
        if (!toTarget) fail(`no publish target — pass --to (or set manifest.publish.${kind === 'oci' ? 'registry' : 'repo'})`);
        tag = tag ?? (kind === 'oci' ? manifest.version : `v${manifest.version}`);
        channel = channel ?? manifest.publish?.channels?.[0] ?? 'stable';
      }

      const body = {
        path: appPath, kind, to: toTarget,
        tag, channel, branch: o.branch,
      };
      const res = await api.post<{
        ok: boolean; source: 'git' | 'oci';
        result?: { ref: string; installCmd?: string };
        messages?: string[]; error?: string;
      }>('/api/nexus/publish', body);
      if (!res.ok || !res.result) fail(res.error ?? 'publish failed');
      for (const m of res.messages ?? []) info(`  ${m}`);
      ok(`published ${color.cyan(res.result!.ref)}`);

      if (o.submit || wantSubmit) {
        const r = res.result as PublishResult;
        await runSubmit({
          manifest,
          source: kind === 'git'
            ? { kind: 'git', ref: r.repoUrl ?? r.ref, defaultBranch: o.branch ?? 'main' }
            : { kind: 'oci', ref: r.ref },
          channel: channel ?? 'stable',
          tag:     tag ?? (kind === 'oci' ? manifest.version : `v${manifest.version}`),
          storeRepo:    o.storeRepo,
          category:     o.category,
          acceptPolicy: o.acceptPolicy || wantSubmit,
        });
      }
      if (kind === 'oci') {
        info(`  it will appear in the Nexus store — browse it or run ${color.cyan('aura nexus search --refresh')}`);
        info(`  install elsewhere: ${color.cyan(`aura nexus app install ${manifest.id}`)}`);
      } else if (res.result!.installCmd) {
        info(`  install elsewhere: ${color.cyan(res.result!.installCmd)}`);
      }
    });
}

interface PublishPlan { kind: 'oci' | 'git'; to: string; tag: string; channel?: string; submit?: boolean; }

/** Interactive publish wizard. Step machine with ⌃B back navigation, mirroring
 *  `aura dev new`. Returns null when the user declines at confirm. */
async function runPublishWizard(appPath: string, manifest: LocalManifest): Promise<PublishPlan | null> {
  type Step = 'kind' | 'target' | 'tag' | 'channel' | 'submit' | 'confirm';
  const order: Step[] = ['kind', 'target', 'tag', 'channel', 'submit', 'confirm'];
  let i = 0;
  let kind: 'oci' | 'git' = 'oci';
  let to = '';
  let tag = '';
  let channel: string | undefined;
  let submit = false;
  const CUSTOM = ' custom';
  const NONE = ' none';

  while (i < order.length) {
    const step = order[i]!;

    if (step === 'kind') {
      const r: 'oci' | 'git' | typeof BACK = await promptChoice<'oci' | 'git'>('Publish destination', [
        { value: 'oci', label: 'OCI registry', desc: 'self-describing — appears in the Nexus store automatically' },
        { value: 'git', label: 'Git repository', desc: 'install by repo URL; add a git-index/git-app source to list it' },
      ], kind === 'oci' ? 0 : 1);
      if (r === BACK) return null;   // nowhere to go back to
      kind = r; i++;
      continue;
    }

    if (step === 'target') {
      if (kind === 'oci') {
        const sources = await fetchOciSources();
        const choices = sources.map((s) => ({ value: s.name, label: s.name, desc: s.url }));
        choices.push({ value: CUSTOM, label: 'custom URL…', desc: 'enter a registry URL not yet registered' });
        const pick = await promptChoice<string>('Target OCI registry', choices,
          Math.max(0, choices.findIndex((c) => c.value === to)), { allowBack: true });
        if (pick === BACK) { i--; continue; }
        if (pick === CUSTOM) {
          const url = await promptText('Registry URL (http(s)://host:port)', {
            allowBack: true, validate: (v) => /^https?:\/\//.test(v) ? null : 'must start with http:// or https://',
          });
          if (url === BACK) continue;
          to = url;
        } else { to = pick; }
      } else {
        const def = manifest.publish?.repo ?? gitOrigin(appPath) ?? '';
        const url = await promptText('Target git repo (github.com/you/app or https URL)', {
          default: def || undefined, allowBack: true,
          validate: (v) => v ? null : 'a repo URL is required',
        });
        if (url === BACK) { i--; continue; }
        to = url;
      }
      i++;
      continue;
    }

    if (step === 'tag') {
      const defTag = kind === 'oci' ? manifest.version : `v${manifest.version}`;
      const t = await promptText('Tag', { default: defTag, allowBack: true });
      if (t === BACK) { i--; continue; }
      tag = t; i++;
      continue;
    }

    if (step === 'channel') {
      const chans = manifest.publish?.channels ?? ['stable'];
      const choices = [
        ...chans.map((c) => ({ value: c, label: c })),
        { value: NONE, label: 'none', desc: 'no channel tag' },
        { value: CUSTOM, label: 'custom…' },
      ];
      const ch = await promptChoice<string>('Channel', choices, 0, { allowBack: true });
      if (ch === BACK) { i--; continue; }
      if (ch === NONE) channel = undefined;
      else if (ch === CUSTOM) {
        const c = await promptText('Channel label', { allowBack: true });
        if (c === BACK) continue;
        channel = c || undefined;
      } else channel = ch;
      i++;
      continue;
    }

    if (step === 'submit') {
      // Only worth asking when what we just published is reachable by anyone
      // else. A local-registry publish is a test, not a release; offering to
      // list it would be an invitation to open a broken PR.
      if (isLocalTarget(to)) {
        info(color.dim(`  (skipping the store step — ${to} is not publicly reachable)`));
        submit = false;
        i++;
        continue;
      }
      info('');
      info('Listing it in the AuraOS store opens a pull request for a maintainer to review.');
      info(color.dim('  Answering yes attests that you control this app id and have read'));
      info(color.dim('  https://github.com/lacky95/auraos-store/blob/main/POLICY.md'));
      const want = await promptConfirm('Submit to the store?', false, { allowBack: true });
      if (want === BACK) { i--; continue; }
      submit = want === true;
      i++;
      continue;
    }

    // confirm
    reviewStoreMetadata(manifest);
    info('');
    info(color.bold('Publish plan'));
    info(`  kind:     ${kind}`);
    info(`  target:   ${to}`);
    info(`  tag:      ${tag}`);
    info(`  channel:  ${channel ?? color.dim('(none)')}`);
    info(`  submit:   ${submit ? color.cyan('yes — opens a store pull request') : color.dim('no')}`);
    const yes = await promptConfirm('Publish now?', true, { allowBack: true });
    if (yes === BACK) { i--; continue; }
    if (!yes) return null;
    return { kind, to, tag, channel, submit };
  }
  return null;
}

/** True when a publish target only this machine can reach. The store lists
 *  sources anyone can pull, so submitting one of these would produce an entry
 *  that resolves for nobody. */
function isLocalTarget(to: string): boolean {
  const t = to.trim().toLowerCase();
  return t === 'local'
    || t.startsWith('http://')
    || t.startsWith('localhost')
    || t.startsWith('127.')
    || t.includes('aura-com.aura.registry');
}

/** Print the storefront metadata and warn about anything missing — those
 *  fields render as '—' in the store. */
function reviewStoreMetadata(manifest: LocalManifest): void {
  info('');
  info(color.bold('Store metadata'));
  const s = manifest.store ?? {};
  const row = (label: string, val: string | undefined) =>
    info(`  ${label.padEnd(12)} ${val ? val : color.dim('—')}`);
  row('publisher', s.publisher);
  row('homepage', s.homepage);
  row('license', s.license);
  row('tags', s.tags?.length ? s.tags.join(', ') : undefined);
  row('screenshots', s.screenshots?.length ? `${s.screenshots.length} url(s)` : undefined);
  if (!s.publisher) warn('no store.publisher — shows as "—" in the store');
  if (!s.longDescription) warn('no store.longDescription — the detail page will be sparse');
}

async function fetchOciSources(): Promise<SourceEntry[]> {
  try {
    const cfg = await api.get<{ sources: SourceEntry[] }>('/api/nexus/sources');
    return cfg.sources.filter((s) => s.kind === 'oci');
  } catch { return []; }
}

function gitOrigin(appPath: string): string | undefined {
  try {
    const url = execFileSync('git', ['-C', appPath, 'remote', 'get-url', 'origin'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 }).toString().trim();
    return url || undefined;
  } catch { return undefined; }
}

function readManifestAt(appPath: string): LocalManifest {
  const p = join(appPath, 'app.manifest.json');
  if (!existsSync(p)) fail(`no app.manifest.json in ${appPath}`);
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as LocalManifest;
  } catch (err) {
    return fail(`invalid app.manifest.json: ${(err as Error).message}`);
  }
}

// ─── app install ──────────────────────────────────────────────────────────
/**
 * POST and keep the server's own error message and hint.
 *
 * `api.post` throws on any non-2xx, and the store routes answer user errors
 * with a 400 whose body carries a precisely worded `error` and a `hint` for
 * fixing it. Without this the caller's error rendering never runs and the user
 * sees a raw `POST /api/... failed with 400: {"ok":false,...}` instead — the
 * information is all there, just wrapped in the wrong thing.
 */
async function postStore<T>(path: string, body: unknown): Promise<T> {
  try {
    return await api.post<T>(path, body);
  } catch (err) {
    const raw = (err as { body?: string }).body;
    if (raw) {
      try { return JSON.parse(raw) as T; } catch { /* not JSON — rethrow below */ }
    }
    throw err;
  }
}

// ─── app submit ─────────────────────────────────────────────────────────────
/** What `/api/nexus/publish` actually returns for a git publish — richer than
 *  the CLI historically typed. `repoUrl` is what a store entry needs. */
interface PublishResult { ref: string; repoUrl?: string; tag?: string; installCmd?: string }

interface SubmitArgs {
  manifest:      LocalManifest;
  source:        { kind: 'git' | 'oci'; ref: string; defaultBranch?: string };
  channel:       string;
  tag:           string;
  storeRepo?:    string;
  category?:     string;
  dryRun?:       boolean;
  updateMetadata?: boolean;
  noCodeowners?: boolean;
  force?:        boolean;
  acceptPolicy?: boolean;
}

/** POST the submission and render the outcome. Shared by `app submit` and
 *  `app publish --submit` so the two cannot drift. */
async function runSubmit(a: SubmitArgs): Promise<void> {
  const res = await postStore<{
    ok: boolean; storeRepo: string; error?: string; hint?: string;
    messages?: string[];
    result?: {
      problems: Array<{ field: string; severity: 'error' | 'warn'; message: string }>;
      entryYaml: string; change: 'create' | 'update'; branch: string;
      prUrl?: string; unchanged?: boolean; mode?: 'owner' | 'fork'; diffStat?: string;
    };
  }>('/api/nexus/submit', {
    manifest: a.manifest, source: a.source, channel: a.channel, tag: a.tag,
    storeRepo: a.storeRepo, category: a.category,
    dryRun: a.dryRun, updateMetadata: a.updateMetadata,
    noCodeowners: a.noCodeowners, force: a.force, acceptPolicy: a.acceptPolicy,
  });

  for (const m of res.messages ?? []) info(`  ${m}`);

  if (!res.ok || !res.result) {
    if (res.error) console.error(`\n${color.red('✗')} ${res.error}`);
    if (res.hint)  info(`  ${res.hint}`);
    fail('submission failed');
  }

  const r = res.result;
  for (const p of r.problems.filter((x) => x.severity === 'warn')) {
    warn(`${p.field}: ${p.message}`);
  }

  if (r.unchanged) {
    ok(`${color.cyan(res.storeRepo)} already lists this exact entry — nothing to do`);
    return;
  }
  if (a.dryRun) {
    info('');
    info(color.dim(`  would open: ${r.change === 'create' ? 'a new listing' : 'an update'} on branch ${r.branch}`));
    if (r.diffStat) for (const l of r.diffStat.split('\n')) info(`  ${l}`);
    info('');
    for (const l of r.entryYaml.trimEnd().split('\n')) info(color.dim(`  ${l}`));
    ok('dry run — nothing was pushed');
    return;
  }
  ok(`${r.change === 'create' ? 'submitted' : 'updated'} ${color.cyan(res.storeRepo)} — ${r.prUrl}`);
  info('  a maintainer reviews and merges it; the index rebuilds on merge.');
}

function wireSubmit(parent: Command): void {
  parent
    .command('submit [path]')
    .description('Open a pull request listing an already-published app in the store.')
    .option('--kind <kind>',       'how it was published: git | oci (default: git)')
    .option('--from <ref>',        'the published source: a git repo or an OCI ref')
    .option('--tag <tag>',         'the published tag (default: v<version> for git, <version> for oci)')
    .option('--channel <name>',    'channel the tag belongs to', 'stable')
    .option('--branch <name>',     'default branch of the source repo', 'main')
    .option('--store-repo <slug>', 'store index repo (owner/repo)')
    .option('--category <slug>',   'store category, when the manifest category has no store equivalent')
    .option('--dry-run',           'show the entry and the diff without touching GitHub')
    .option('--update-metadata',   'refresh the whole entry, not just the channel tag')
    .option('--no-codeowners',     'do not claim the entry in CODEOWNERS')
    .option('--force',             'overwrite a submission branch someone has edited')
    .option('--accept-policy',     'attest namespace ownership + that you have read POLICY.md')
    .action(async (path: string | undefined, o: {
      kind?: string; from?: string; tag?: string; channel: string; branch: string;
      storeRepo?: string; category?: string; dryRun?: boolean; updateMetadata?: boolean;
      codeowners?: boolean; force?: boolean; acceptPolicy?: boolean;
    }) => {
      const appPath = resolve(path ?? '.');
      if (!existsSync(appPath) || !statSync(appPath).isDirectory()) fail(`not a directory: ${appPath}`);
      const manifest = readManifestAt(appPath);
      info(`app: ${color.cyan(manifest.id)} ${manifest.name} v${manifest.version}`);

      const kind = (o.kind === 'oci' ? 'oci' : 'git') as 'git' | 'oci';
      // Fall back to what the manifest says it publishes to, then to the app
      // dir's own origin — the same resolution order publish uses.
      const from = o.from
        ?? (kind === 'git' ? (manifest.publish?.repo ?? gitOrigin(appPath)) : manifest.publish?.registry);
      if (!from) {
        fail(`no published source — pass --from (e.g. --from github.com/you/repo)`);
      }
      const tag = o.tag ?? (kind === 'oci' ? manifest.version : `v${manifest.version}`);

      await runSubmit({
        manifest,
        source: { kind, ref: from!, defaultBranch: o.branch },
        channel: o.channel, tag,
        storeRepo: o.storeRepo, category: o.category,
        dryRun: o.dryRun, updateMetadata: o.updateMetadata,
        noCodeowners: o.codeowners === false,
        force: o.force, acceptPolicy: o.acceptPolicy,
      });
    });
}


// ─── app screenshots ────────────────────────────────────────────────────────
/** Screenshots change on their own schedule — a better picture is not a new
 *  release — so they get their own command rather than riding on publish. */
function wireScreenshots(parent: Command): void {
  const shots = parent
    .command('screenshots')
    .alias('shots')
    .description('Add, replace, remove or list the screenshots on a store listing.');

  const call = async (
    appId: string,
    action: 'list' | 'add' | 'remove' | 'replace',
    o: { source?: string; index?: number; storeRepo?: string; dryRun?: boolean; force?: boolean },
  ) => {
    const res = await postStore<{
      ok: boolean; storeRepo: string; error?: string; hint?: string; messages?: string[];
      result?: {
        appId: string; screenshots: string[];
        uploaded?: { path: string; url: string; bytes: number };
        deleted?: string; prUrl?: string; unchanged?: boolean; diffStat?: string;
      };
    }>('/api/nexus/screenshots', {
      appId, action, source: o.source, index: o.index,
      storeRepo: o.storeRepo, dryRun: o.dryRun, force: o.force,
    });

    for (const m of res.messages ?? []) info(`  ${m}`);
    if (!res.ok || !res.result) {
      if (res.error) console.error(`\n${color.red('✗')} ${res.error}`);
      if (res.hint)  info(`  ${res.hint}`);
      fail('screenshots: no change made');
    }

    const r = res.result;
    if (!r.screenshots.length) info(color.dim('  (no screenshots)'));
    r.screenshots.forEach((u, i) => info(`  ${color.dim(String(i + 1) + '.')} ${u}`));

    if (action === 'list') return;
    if (r.unchanged) { ok('nothing to change'); return; }
    if (o.dryRun)    { ok('dry run — nothing was pushed'); return; }
    ok(`${color.cyan(res.storeRepo)} — ${r.prUrl}`);
    info('  a maintainer reviews and merges it; the listing updates on merge.');
  };

  const common = (c: Command) => c
    .option('--store-repo <slug>', 'store index repo (owner/repo)')
    .option('--dry-run',           'show the change without touching GitHub')
    .option('--force',             'overwrite a screenshot branch someone has edited');

  common(shots.command('list <appId>')
    .description('Show the screenshots currently listed, numbered.'))
    .action(async (appId: string, o: { storeRepo?: string }) => {
      await call(appId, 'list', o);
    });

  common(shots.command('add <appId> <image>')
    .description('Add a screenshot. <image> is a local file (uploaded to the store) or an https URL.'))
    .action(async (appId: string, image: string, o: { storeRepo?: string; dryRun?: boolean; force?: boolean }) => {
      await call(appId, 'add', { ...o, source: image });
    });

  common(shots.command('replace <appId> <n> <image>')
    .description('Replace screenshot <n> (as printed by `list`).'))
    .action(async (appId: string, n: string, image: string, o: { storeRepo?: string; dryRun?: boolean; force?: boolean }) => {
      await call(appId, 'replace', { ...o, index: Number(n), source: image });
    });

  common(shots.command('remove <appId> <n>')
    .description('Remove screenshot <n>. An image this store hosts is deleted with it.'))
    .action(async (appId: string, n: string, o: { storeRepo?: string; dryRun?: boolean; force?: boolean }) => {
      await call(appId, 'remove', { ...o, index: Number(n) });
    });
}

// ─── store credentials ──────────────────────────────────────────────────────
/** Read all of stdin — used for piping a secret in rather than typing it. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function wireStore(parent: Command): void {
  const store = parent.command('store').description('Credentials + status for submitting to the app store.');

  store
    .command('login')
    .description('Store a GitHub token for store submissions (sealed in Aura Context, injected into no app).')
    .action(async () => {
      info('A fine-grained token needs Contents and Pull requests: read and write.');
      info('If you already use the GitHub CLI, `gh auth login` is enough — no token needed here.');
      // Read from stdin when piped, the way `gh auth login --with-token` does:
      // it keeps the value out of shell history, out of argv (where `ps` would
      // show it) and out of the terminal scrollback.
      const token = process.stdin.isTTY
        ? await promptText('GitHub token (input is visible — piping is safer: aura nexus store login < token.txt)')
        : await readStdin();
      if (!token) { info('cancelled'); return; }
      // inject: [] — sealed in the KV and handed to no app container. Both
      // other targets are broadcast to every app, which is not acceptable for
      // a credential that can write to repositories.
      await api.post('/api/os/context', {
        key: 'GITHUB_TOKEN', value: token, kind: 'secret', inject: [],
      });
      ok('stored GITHUB_TOKEN (OS only — not injected into any app)');
    });

  store
    .command('status')
    .description('Show which store submissions target, and whether a token is available.')
    .action(async () => {
      const res = await api.get<{
        storeRepo: string; tokenOrigin: string | null; login: string | null;
        mode: 'owner' | 'fork' | null; error?: string;
      }>('/api/nexus/submit');
      info(`store:  ${color.cyan(res.storeRepo)}`);
      info(`token:  ${res.tokenOrigin
        ? `${res.tokenOrigin === 'gh' ? 'gh auth' : 'Aura Context'}`
        : color.red('none')}`);
      info(`user:   ${res.login ?? color.dim('—')}`);
      // owner = can push a branch straight to the store; fork = we open the PR
      // from a fork of it. Worth surfacing, because it changes what a failure
      // later on will mean.
      info(`mode:   ${res.mode === 'owner' ? 'owner (direct branch)'
        : res.mode === 'fork' ? 'fork (PR from your fork)'
        : color.dim('—')}`);
      if (res.error) warn(res.error);
      if (!res.tokenOrigin) {
        info('  run `gh auth login`, or `aura nexus store login` to store a token');
      }
    });
}

function wireInstall(parent: Command, opts: { hidden?: boolean } = {}): void {
  parent
    .command('install <ref>', { hidden: opts.hidden })
    .description('Install an app. <ref> can be a git URL, OCI tag, index id, or local path.')
    .option('-y, --yes',             'auto-approve any permission changes')
    .option('--channel <name>',      'channel to install (when <ref> is an index id)', 'stable')
    .option('--scope <global|user>', 'install into this scope (default: global)', 'global')
    .action(async (rawRef: string, o: { yes?: boolean; channel?: string; scope?: string }) => {
      const ref = normaliseRef(rawRef);
      if (o.scope === 'system') fail('cannot install into system scope');
      const scope = o.scope === 'user' ? 'user' : 'global';

      let res = await api.post<InstallResponse>('/api/nexus/install',
        { ref, scope, autoApprove: !!o.yes });

      if (res.needsApproval && res.diff) {
        printPermissionDiff(res.diff);
        try {
          const okPrompt = await promptConfirm('Approve and install?', false);
          if (okPrompt !== true) { info('install cancelled'); return; }
        } catch (err) {
          if (err instanceof PromptCancelled) { info('install cancelled'); return; }
          throw err;
        }
        res = await api.post<InstallResponse>('/api/nexus/install',
          { ref, scope, autoApprove: true });
      }

      if (!res.ok || !res.record) fail(res.error ?? 'install failed');
      ok(`installed ${color.cyan(res.record!.id)} (${res.record!.version}) from ${res.record!.source} → scope:${scope}`);
      info(`  ref:    ${res.record!.ref}`);
      if (res.record!.digest) info(`  digest: ${res.record!.digest.slice(0, 16)}`);
    });
}

// ─── app update ─────────────────────────────────────────────────────────────
function wireUpdate(parent: Command, opts: { hidden?: boolean } = {}): void {
  parent
    .command('update [id]', { hidden: opts.hidden })
    .description('Re-resolve an installed app and reinstall if updated.')
    .option('-y, --yes', 'auto-approve any permission changes')
    .option('--all',     'update every Nexus-installed app')
    .action(async (id: string | undefined, o: { yes?: boolean; all?: boolean }) => {
      if (!id && !o.all) fail('pass an <id> or --all');
      const ids: string[] = id
        ? [id]
        : (await api.get<InstalledItem[]>('/api/nexus/installed'))
            .filter((it) => it.isNexusInstalled && it.record.source !== 'local')
            .map((it) => it.manifest.id);
      if (ids.length === 0) { info('no Nexus-installed apps to update'); return; }
      for (const i of ids) {
        info(`updating ${i}...`);
        let res = await api.post<InstallResponse>(`/api/nexus/update/${encodeURIComponent(i)}`,
          { autoApprove: !!o.yes });
        if (res.needsApproval && res.diff) {
          printPermissionDiff(res.diff);
          const okPrompt = await promptConfirm('Approve and update?', false).catch(() => false as const);
          if (okPrompt !== true) { info(`  → ${i} skipped`); continue; }
          res = await api.post<InstallResponse>(`/api/nexus/update/${encodeURIComponent(i)}`,
            { autoApprove: true });
        }
        if (!res.ok) info(`  → ${i} failed: ${res.error ?? '<unknown>'}`);
        else        ok(`  → ${i} updated to ${res.record?.version ?? '<?>'}`);
      }
    });
}

// ─── app uninstall ────────────────────────────────────────────────────────
function wireUninstall(parent: Command, opts: { hidden?: boolean } = {}): void {
  parent
    .command('uninstall <id>', { hidden: opts.hidden })
    .description('Remove an installed app. Per-app data preserved unless --purge.')
    .option('--purge', 'also remove the app\'s persistent data in /data/apps/<id>/')
    .action(async (id: string, o: { purge?: boolean }) => {
      const qs = o.purge ? '?purge=1' : '';
      const res = await api.post<{ ok: boolean; id: string; purged: boolean }>(
        `/api/nexus/uninstall/${encodeURIComponent(id)}${qs}`,
      );
      if (!res.ok) fail('uninstall failed');
      ok(`uninstalled ${id}${res.purged ? ' (data purged)' : ''}`);
    });
}

// ─── app list ───────────────────────────────────────────────────────────────
function wireList(parent: Command, opts: { hidden?: boolean } = {}): void {
  parent
    .command('list', { hidden: opts.hidden })
    .alias('ls')
    .description('List installed apps + their Nexus source.')
    .option('--source <source>', 'filter by source: git, oci, index, local')
    .action(async (o: { source?: string }) => {
      const rows = await api.get<InstalledItem[]>('/api/nexus/installed');
      const filtered = o.source ? rows.filter((r) => r.record.source === o.source) : rows;
      if (filtered.length === 0) { info('no apps installed'); return; }
      console.log(table(
        filtered.map((r) => ({
          id:      r.manifest.id,
          version: r.manifest.version,
          scope:   (r as { scope?: string }).scope ?? r.record.scope ?? 'system',
          source:  r.record.source,
          ref:     r.record.source === 'local' ? r.record.ref : shortenRef(r.record.ref),
        })),
        ['id', 'version', 'scope', 'source', 'ref'],
      ));
    });
}

// ─── app info ───────────────────────────────────────────────────────────────
function wireInfo(parent: Command, opts: { hidden?: boolean } = {}): void {
  parent
    .command('info <ref>', { hidden: opts.hidden })
    .description('Preview an install: resolve the ref, fetch into a sandbox, show the manifest + permission diff.')
    .action(async (rawRef: string) => {
      const ref = normaliseRef(rawRef);
      const res = await api.post<{
        ok: boolean;
        resolved?: { source: string; address: string; digest: string };
        manifest?: { id: string; name: string; version: string };
        diff?: PermissionDiff;
        error?: string;
      }>('/api/nexus/preview', { ref });
      if (!res.ok || !res.resolved || !res.manifest) fail(res.error ?? 'preview failed');
      ok(`${res.manifest!.id} ${res.manifest!.version}`);
      info(`  source:  ${res.resolved!.source}`);
      info(`  address: ${res.resolved!.address}`);
      if (res.resolved!.digest) info(`  digest:  ${res.resolved!.digest.slice(0, 16)}`);
      if (res.diff) printPermissionDiff(res.diff, { compact: true });
    });
}

// ─── search ─────────────────────────────────────────────────────────────────
function wireSearch(parent: Command): void {
  parent
    .command('search [query]')
    .description('Search the aggregated app catalog by id, name, description, or tag.')
    .option('--category <slug>', 'filter by category slug')
    .option('--refresh',         're-fetch every source before searching')
    .action(async (query: string | undefined, o: { category?: string; refresh?: boolean }) => {
      const qs = new URLSearchParams();
      if (query) qs.set('q', query);
      if (o.category) qs.set('category', o.category);
      if (o.refresh) qs.set('refresh', '1');
      const res = await api.get<{ results: CatalogEntry[] }>(`/api/nexus/search?${qs}`);
      if (res.results.length === 0) {
        info('no matches (no sources registered, or all offline)');
        return;
      }
      console.log(table(
        res.results.map((e) => ({
          id:          e.id,
          name:        e.name,
          version:     e.version ?? '-',
          source:      e.sourceName ?? '-',
          publisher:   e.publisher ?? '-',
          description: (e.description ?? '').slice(0, 48),
        })),
        ['id', 'name', 'version', 'source', 'publisher', 'description'],
      ));
    });
}

// ─── registry management ──────────────────────────────────────────────────
function wireRegistry(registry: Command): void {
  registry
    .command('list', { isDefault: true })
    .description('Print every registered source with its kind, priority + flags.')
    .action(async () => {
      const cfg = await api.get<{ sources: SourceEntry[] }>('/api/nexus/sources');
      if (!cfg.sources.length) { info('no sources configured.'); return; }
      const rows = [...cfg.sources]
        .sort((a, b) => a.priority - b.priority)
        .map((e) => ({
          NAME:     e.name,
          KIND:     e.kind,
          URL:      e.url,
          PRIORITY: String(e.priority),
          EXTRA:    e.kind === 'oci' ? (e.mirror ? 'mirror' : '') : (e.ref ? `ref:${e.ref}` : ''),
        }));
      console.log(table(rows));
    });

  registry
    .command('add <name> <url>')
    .description('Add a source. Declare its kind explicitly — a git repo is either a catalog (git-index) or a single app (git-app).')
    .option('--kind <kind>',   'oci | git-index | git-app (default: oci)', 'oci')
    .option('--priority <n>',  'lower = checked first', '10')
    .option('--mirror',        '[oci] probe this registry for ANY ref before the canonical host')
    .option('--ref <ref>',     '[git-*] branch/tag/commit (default remote HEAD)')
    .action(async (name: string, url: string, o: { kind?: string; priority?: string; mirror?: boolean; ref?: string }) => {
      const kind = (o.kind ?? 'oci') as SourceEntry['kind'];
      if (!['oci', 'git-index', 'git-app'].includes(kind)) {
        fail(`invalid --kind '${kind}' (expected oci | git-index | git-app)`);
      }
      if (kind === 'oci' && !/^https?:\/\//.test(url)) {
        fail('oci url must start with http:// or https://');
      }
      const entry: SourceEntry = { kind, name, url, priority: Number(o.priority ?? 10) };
      if (kind === 'oci' && o.mirror) entry.mirror = true;
      if (kind !== 'oci' && o.ref)    entry.ref = o.ref;

      info(kind === 'oci' ? 'registering registry…' : 'validating source (cloning/fetching)…');
      const res = await api.post<{ ok?: boolean; error?: string; detail?: string; kind?: string }>(
        '/api/nexus/sources', entry,
      );
      if (!res.ok) fail(`${res.error}${res.detail ? ` — ${res.detail}` : ''}`);
      ok(`added ${kind} source ${color.cyan(name)} → ${url}`);
    });

  registry
    .command('remove <name>')
    .description('Remove a source by name. Refuses to remove the last OCI registry.')
    .action(async (name: string) => {
      const res = await api.del<{ ok?: boolean; error?: string; detail?: string }>(
        `/api/nexus/sources/${encodeURIComponent(name)}`,
      );
      if (!res.ok) fail(`${res.error}${res.detail ? ` — ${res.detail}` : ''}`);
      ok(`removed source ${color.cyan(name)}`);
    });
}

/** Normalise a user-typed ref so the shell receives an absolute path when the
 *  user meant a local directory. Anything else passes through. */
function normaliseRef(s: string): string {
  if (s.startsWith('./') || s.startsWith('../') || s.startsWith('/')) {
    const abs = resolve(s);
    return existsSync(abs) ? abs : s;
  }
  return s;
}

function shortenRef(s: string): string {
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

interface DiffPrintOpts { compact?: boolean; }

function printPermissionDiff(diff: PermissionDiff, opts: DiffPrintOpts = {}): void {
  const v = diff.versionFrom ? `${diff.versionFrom} → ${diff.versionTo}` : diff.versionTo;
  if (!opts.compact) {
    info('');
    info(color.bold(`Review install: ${diff.appId} (${v})`));
  }
  if (diff.toolsAdded.length)         info(`  ${color.yellow('+ tools')}        ${diff.toolsAdded.join(', ')}`);
  if (diff.toolsRemoved.length)       info(`  ${color.dim('- tools')}        ${diff.toolsRemoved.join(', ')}`);
  if (diff.permissionsAdded.length)   info(`  ${color.yellow('+ permissions')}  ${diff.permissionsAdded.join(', ')}`);
  if (diff.permissionsRemoved.length) info(`  ${color.dim('- permissions')}  ${diff.permissionsRemoved.join(', ')}`);
  if (diff.dataProviderAdded)         info(`  ${color.yellow('+ data provider')}   exposes /api/data/${diff.appId}/...`);
  if (diff.dataProviderRemoved)       info(`  ${color.dim('- data provider')}   no longer exposed`);
  if (diff.intentFiltersAdded.length) {
    info(`  ${color.yellow('+ intent filters')}:`);
    for (const f of diff.intentFiltersAdded) info(`      ${f}`);
  }
}
