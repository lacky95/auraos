/**
 * `aura nexus *` — the AuraOS distribution CLI. Posts to the shell's
 * `/api/nexus/*` endpoints; never touches the filesystem directly.
 *
 * v1 commands wired:
 *   aura nexus install   <ref>           [--yes] [--channel stable]
 *   aura nexus update    [<id>|--all]    [--yes]
 *   aura nexus uninstall <id>            [--purge]
 *   aura nexus list                      [--source git|oci|index|local]
 *   aura nexus search    [<query>]       [--category <slug>]
 *   aura nexus info      <ref>
 *   aura nexus publish   [<path>]        [--source git|oci] [--repo <url>]
 *                                        [--registry <ref>] [--tag <tag>]
 *                                        [--channel <name>] [--branch <name>]
 */
import type { Command } from 'commander';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { api } from '../lib/client.js';
import { color, fail, info, ok, table } from '../lib/format.js';
import { promptConfirm, PromptCancelled } from '../lib/prompts.js';

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

interface IndexEntry {
  id:           string;
  name:         string;
  description?: string;
  publisher?:   string;
  categories?:  string[];
  tags?:        string[];
}

export function registerNexus(program: Command): void {
  const nexus = program
    .command('nexus')
    .description('Install, update, publish, and discover Aura apps via Nexus.');

  // ── install ─────────────────────────────────────────────────────────────
  nexus
    .command('install <ref>')
    .description('Install an app. <ref> can be a git URL, OCI tag, index id, or local path.')
    .option('-y, --yes',         'auto-approve any permission changes')
    .option('--channel <name>',  'channel to install (when <ref> is an index id)', 'stable')
    .action(async (rawRef: string, opts: { yes?: boolean; channel?: string }) => {
      const ref = normaliseRef(rawRef);

      // First attempt — autoApprove only if --yes was passed.
      let res = await api.post<InstallResponse>('/api/nexus/install',
        { ref, autoApprove: !!opts.yes });

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
          { ref, autoApprove: true });
      }

      if (!res.ok || !res.record) {
        fail(res.error ?? 'install failed');
      }
      ok(`installed ${color.cyan(res.record!.id)} (${res.record!.version}) from ${res.record!.source}`);
      info(`  ref:    ${res.record!.ref}`);
      if (res.record!.digest) info(`  digest: ${res.record!.digest.slice(0, 16)}`);
    });

  // ── update ──────────────────────────────────────────────────────────────
  nexus
    .command('update [id]')
    .description('Re-resolve an installed app and reinstall if updated.')
    .option('-y, --yes', 'auto-approve any permission changes')
    .option('--all',     'update every Nexus-installed app')
    .action(async (id: string | undefined, opts: { yes?: boolean; all?: boolean }) => {
      if (!id && !opts.all) {
        fail('pass an <id> or --all');
      }
      const ids: string[] = id
        ? [id]
        : (await api.get<InstalledItem[]>('/api/nexus/installed'))
            .filter((it) => it.isNexusInstalled && it.record.source !== 'local')
            .map((it) => it.manifest.id);
      if (ids.length === 0) {
        info('no Nexus-installed apps to update');
        return;
      }
      for (const i of ids) {
        info(`updating ${i}...`);
        let res = await api.post<InstallResponse>(`/api/nexus/update/${encodeURIComponent(i)}`,
          { autoApprove: !!opts.yes });
        if (res.needsApproval && res.diff) {
          printPermissionDiff(res.diff);
          const okPrompt = await promptConfirm('Approve and update?', false)
            .catch(() => false as const);
          if (okPrompt !== true) { info(`  → ${i} skipped`); continue; }
          res = await api.post<InstallResponse>(`/api/nexus/update/${encodeURIComponent(i)}`,
            { autoApprove: true });
        }
        if (!res.ok) {
          info(`  → ${i} failed: ${res.error ?? '<unknown>'}`);
        } else {
          ok(`  → ${i} updated to ${res.record?.version ?? '<?>'}`);
        }
      }
    });

  // ── uninstall ───────────────────────────────────────────────────────────
  nexus
    .command('uninstall <id>')
    .description('Remove an installed app. Per-app data preserved unless --purge.')
    .option('--purge', 'also remove the app\'s persistent data in /data/apps/<id>/')
    .action(async (id: string, opts: { purge?: boolean }) => {
      const qs = opts.purge ? '?purge=1' : '';
      const res = await api.post<{ ok: boolean; id: string; purged: boolean }>(
        `/api/nexus/uninstall/${encodeURIComponent(id)}${qs}`,
      );
      if (!res.ok) fail('uninstall failed');
      ok(`uninstalled ${id}${res.purged ? ' (data purged)' : ''}`);
    });

  // ── list ────────────────────────────────────────────────────────────────
  nexus
    .command('list')
    .alias('ls')
    .description('List installed apps + their Nexus source.')
    .option('--source <source>', 'filter by source: git, oci, index, local')
    .action(async (opts: { source?: string }) => {
      const rows = await api.get<InstalledItem[]>('/api/nexus/installed');
      const filtered = opts.source
        ? rows.filter((r) => r.record.source === opts.source)
        : rows;
      if (filtered.length === 0) {
        info('no apps installed');
        return;
      }
      console.log(table(
        filtered.map((r) => ({
          id:      r.manifest.id,
          version: r.manifest.version,
          source:  r.record.source,
          ref:     r.record.source === 'local' ? r.record.ref : shortenRef(r.record.ref),
        })),
        ['id', 'version', 'source', 'ref'],
      ));
    });

  // ── search ──────────────────────────────────────────────────────────────
  nexus
    .command('search [query]')
    .description('Search the curated index by id, name, description, or tag.')
    .option('--category <slug>', 'filter by category slug')
    .action(async (query: string | undefined, opts: { category?: string }) => {
      const qs = new URLSearchParams();
      if (query) qs.set('q', query);
      if (opts.category) qs.set('category', opts.category);
      const res = await api.get<{ results: IndexEntry[] }>(`/api/nexus/search?${qs}`);
      if (res.results.length === 0) {
        info('no matches (or the index repo is unreachable)');
        return;
      }
      console.log(table(
        res.results.map((e) => ({
          id:          e.id,
          name:        e.name,
          publisher:   e.publisher ?? '-',
          description: (e.description ?? '').slice(0, 60),
        })),
        ['id', 'name', 'publisher', 'description'],
      ));
    });

  // ── info ────────────────────────────────────────────────────────────────
  nexus
    .command('info <ref>')
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
      if (!res.ok || !res.resolved || !res.manifest) {
        fail(res.error ?? 'preview failed');
      }
      ok(`${res.manifest!.id} ${res.manifest!.version}`);
      info(`  source:  ${res.resolved!.source}`);
      info(`  address: ${res.resolved!.address}`);
      if (res.resolved!.digest) info(`  digest:  ${res.resolved!.digest.slice(0, 16)}`);
      if (res.diff) printPermissionDiff(res.diff, { compact: true });
    });

  // ── publish ─────────────────────────────────────────────────────────────
  nexus
    .command('publish [path]')
    .description('Publish an app. Git is the v1 path; --source oci requires `oras`.')
    .option('--source <source>',   'git (default) or oci', 'git')
    .option('--repo <url>',        'git target repo (overrides manifest.publish.repo)')
    .option('--registry <ref>',    'oci target registry (overrides manifest.publish.registry)')
    .option('--tag <tag>',         'version tag (default = v<manifest.version>)')
    .option('--channel <name>',    'channel label (extra tag pushed alongside)')
    .option('--branch <name>',     'git branch (default main)')
    .action(async (path: string | undefined, opts: {
      source?: string; repo?: string; registry?: string;
      tag?: string; channel?: string; branch?: string;
    }) => {
      const appPath = resolve(path ?? '.');
      if (!existsSync(appPath) || !statSync(appPath).isDirectory()) {
        fail(`not a directory: ${appPath}`);
      }
      const body = {
        path: appPath,
        source: (opts.source ?? 'git') as 'git' | 'oci',
        repo:    opts.repo,
        registry: opts.registry,
        tag:      opts.tag,
        channel:  opts.channel,
        branch:   opts.branch,
      };
      const res = await api.post<{
        ok: boolean;
        source: 'git' | 'oci';
        result?: { ref: string; installCmd?: string };
        messages?: string[];
        error?: string;
      }>('/api/nexus/publish', body);
      if (!res.ok || !res.result) fail(res.error ?? 'publish failed');
      for (const m of res.messages ?? []) info(`  ${m}`);
      ok(`published ${res.result!.ref}`);
      if (res.result!.installCmd) {
        info(`  install elsewhere with:`);
        info(`    ${color.cyan(res.result!.installCmd)}`);
      }
    });
}

/** Normalise a user-typed ref so the shell receives an absolute path
 *  when the user meant a local directory. Anything else passes through. */
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

interface DiffPrintOpts {
  compact?: boolean;
}

function printPermissionDiff(diff: PermissionDiff, opts: DiffPrintOpts = {}): void {
  const v = diff.versionFrom
    ? `${diff.versionFrom} → ${diff.versionTo}`
    : diff.versionTo;
  if (!opts.compact) {
    info('');
    info(color.bold(`Review install: ${diff.appId} (${v})`));
  }
  if (diff.toolsAdded.length) {
    info(`  ${color.yellow('+ tools')}        ${diff.toolsAdded.join(', ')}`);
  }
  if (diff.toolsRemoved.length) {
    info(`  ${color.dim('- tools')}        ${diff.toolsRemoved.join(', ')}`);
  }
  if (diff.permissionsAdded.length) {
    info(`  ${color.yellow('+ permissions')}  ${diff.permissionsAdded.join(', ')}`);
  }
  if (diff.permissionsRemoved.length) {
    info(`  ${color.dim('- permissions')}  ${diff.permissionsRemoved.join(', ')}`);
  }
  if (diff.dataProviderAdded) {
    info(`  ${color.yellow('+ data provider')}   exposes /api/data/${diff.appId}/...`);
  }
  if (diff.dataProviderRemoved) {
    info(`  ${color.dim('- data provider')}   no longer exposed`);
  }
  if (diff.intentFiltersAdded.length) {
    info(`  ${color.yellow('+ intent filters')}:`);
    for (const f of diff.intentFiltersAdded) info(`      ${f}`);
  }
}
