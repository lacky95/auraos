import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { api } from '../lib/client.js';
import { color, fail, info, ok, table, warn } from '../lib/format.js';
import { promptChoice, promptConfirm, promptMultiSelect, BACK, PromptCancelled } from '../lib/prompts.js';
import { BUILTIN_PERMISSIONS } from '@aura/core';

/** Concrete array form of the core const (typed as a readonly tuple there). */
const BUILTIN_PERMISSIONS_LIST: string[] = [...BUILTIN_PERMISSIONS];
/**
 * Permissions that actually deny today. Mirrors `ENFORCED` in
 * core's PermissionManager — everything else is auto-granted by the MVP path,
 * so the picker should not imply otherwise.
 */
const ENFORCED_PERMISSIONS: string[] = ['apps.mount'];

interface ManifestLite {
  id: string;
  name: string;
  version: string;
  instanceMode: string;
  activityMode: string;
  backgroundService: boolean;
  tools: string[];
}

interface AppDto {
  manifest: ManifestLite;
  enabled?: boolean;
  instances: Array<{ instanceId: string; state: string; port: number | null }>;
  activities: unknown[];
}

export function registerApp(program: Command): void {
  const app = program.command('app').description('Manage installed apps.');

  app
    .command('list')
    .alias('ls')
    .description('List all installed apps with their manifest summary.')
    .action(async () => {
      const apps = await api.get<AppDto[]>('/api/apps');
      const rows = apps.map((a) => ({
        ID:        a.manifest.id,
        NAME:      a.manifest.name,
        VERSION:   a.manifest.version,
        INSTANCES: a.instances.length.toString(),
        MODE:      `${a.manifest.instanceMode}/${a.manifest.activityMode}`,
        BG:        a.manifest.backgroundService ? 'yes' : '-',
        // EN column reflects the enable/disable toggle. Default true for any
        // app the shell hasn't been told otherwise about — newly scaffolded
        // apps are live without needing a manual enable.
        EN:        a.enabled === false ? color.red('off') : color.green('on'),
      }));
      console.log(table(rows, ['ID', 'NAME', 'VERSION', 'INSTANCES', 'MODE', 'BG', 'EN']));
    });

  app
    .command('info <appId>')
    .description('Print full manifest + instances + activities for an app.')
    .action(async (appId: string) => {
      const dto = await api.get<{ manifest: unknown; instances: unknown[]; activities: unknown[] }>(
        `/api/apps/${encodeURIComponent(appId)}/status`,
      );
      console.log(color.bold('Manifest:'));
      console.log(JSON.stringify(dto.manifest, null, 2));
      console.log(color.bold('\nInstances:'));
      console.log(JSON.stringify(dto.instances, null, 2));
      console.log(color.bold('\nActivities:'));
      console.log(JSON.stringify(dto.activities, null, 2));
    });

  app
    .command('start <appId>')
    .description('Start an app. Returns the instance ID.')
    .action(async (appId: string) => {
      const res = await api.post<{ instanceId: string }>(`/api/apps/${encodeURIComponent(appId)}/start`);
      ok(`started ${color.bold(res.instanceId)}`);
    });

  app
    .command('stop <appId>')
    .description('Stop ALL instances of an app.')
    .action(async (appId: string) => {
      await api.post(`/api/apps/${encodeURIComponent(appId)}/stop`);
      ok(`stopped all instances of ${appId}`);
    });

  app
    .command('restart <appId>')
    .description('Stop all instances and start one new instance.')
    .action(async (appId: string) => {
      await api.post(`/api/apps/${encodeURIComponent(appId)}/stop`);
      const res = await api.post<{ instanceId: string }>(`/api/apps/${encodeURIComponent(appId)}/start`);
      ok(`restarted, new instance: ${color.bold(res.instanceId)}`);
    });

  app
    .command('install <path>')
    .description('Install an app from a local directory (must contain app.manifest.json).')
    .action(async (path: string) => {
      const abs = resolve(path);
      if (!existsSync(abs)) {
        console.error(`Path does not exist: ${abs}`);
        process.exit(1);
      }
      const res = await api.post<{ appId: string }>('/api/apps', { path: abs });
      ok(`installed ${color.bold(res.appId)} from ${abs}`);
    });

  app
    .command('remove <appId>')
    .alias('rm')
    .option('-y, --yes', 'Skip the confirmation prompt (for scripts).')
    .description('Stop and delete an installed app from disk. Prompts before deleting unless --yes is passed.')
    .action(async (appId: string, opts: { yes?: boolean }) => {
      // Double-check unless explicitly skipped. Default is "no" — the user
      // has to type 'y' to confirm so muscle-memory Enter doesn't blow away
      // an app. On a non-TTY stdin (`echo … | aura …`, CI pipelines) we
      // still require --yes; otherwise the prompt would silently default to
      // "no" and produce a confusing "aborted" message.
      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          fail(`Refusing to delete ${appId} without a TTY confirmation. Re-run with --yes (or -y) to bypass.`);
        }
        try {
          const yes = await promptConfirm(
            `${color.red('Do you want to delete')} ${color.bold(appId)}${color.red('?')} ${color.dim('This stops every running instance and rm -rfs the app directory.')}`,
            /* defaultYes */ false,
          );
          // Treat anything other than an explicit `true` (including the
          // BACK sentinel the helper might return one day) as "abort".
          if (yes !== true) { info('aborted'); return; }
        } catch (err) {
          if (err instanceof PromptCancelled) { info('aborted'); return; }
          throw err;
        }
      }
      const res = await api.post<{ ok?: boolean; removed?: boolean; dest?: string; error?: string }>(
        `/api/apps/${encodeURIComponent(appId)}/remove`,
      );
      if (!res?.ok) fail(`remove failed: ${res?.error ?? 'unknown error'}`);
      ok(`removed ${color.bold(appId)}${res.dest ? color.dim(` (${res.dest})`) : ''}`);
    });

  app
    .command('enable <appId>')
    .description('Enable an app — re-arms autoStart / warmPool and unhides it from the dock + launcher.')
    .action(async (appId: string) => {
      await api.post('/api/admin/apps/enabled', { appId, enabled: true });
      ok(`enabled ${color.bold(appId)}`);
    });

  app
    .command('disable <appId>')
    .description('Disable an app — stops every running instance and hides it from the dock + launcher.')
    .action(async (appId: string) => {
      await api.post('/api/admin/apps/enabled', { appId, enabled: false });
      ok(`disabled ${color.bold(appId)}`);
    });

  registerPerm(app);
}

// ─── aura app perm ─────────────────────────────────────────────────────────

interface PermEditResult {
  ok: true;
  appId: string;
  permission: string;
  changed: boolean;
  permissions: string[];
  /** Not in BUILTIN_PERMISSIONS — probably a typo, since it would grant nothing. */
  unknown?: boolean;
  /** Whether the running registry picked the change up. False ⇒ needs a restart. */
  reloaded?: boolean;
  reloadError?: string;
}

async function editPerm(
  appId: string,
  action: 'add-permission' | 'remove-permission',
  permission: string,
): Promise<PermEditResult> {
  return api.post<PermEditResult>('/api/admin/manifest-edit', { appId, action, permission });
}

/**
 * Report one edit honestly. Two things matter beyond "ok":
 *   • `unknown` — permissions are free-form strings, so a typo is accepted by
 *     the schema and then silently grants nothing.
 *   • `reloaded` — the file can be written while the in-memory registry keeps
 *     the old value, in which case the app still gets 403s. That gap is what
 *     made hermes look granted while every mount failed.
 */
function reportPerm(res: PermEditResult, verb: string): void {
  if (!res.changed) info(`${res.appId} already ${verb === 'granted' ? 'has' : 'lacks'} ${color.bold(res.permission)}`);
  else ok(`${verb} ${color.bold(res.permission)} ${verb === 'granted' ? 'to' : 'from'} ${color.bold(res.appId)}`);
  if (res.unknown) {
    warn(`'${res.permission}' is not a built-in permission — it will grant nothing unless an app defines it.`);
  }
  if (res.reloaded === false) {
    warn(`manifest written but the running registry did NOT reload${res.reloadError ? ` (${res.reloadError})` : ''} — restart the shell for it to take effect.`);
  }
}

async function fetchAppsWithPerms(): Promise<Array<{ id: string; name: string; permissions: string[] }>> {
  const apps = await api.get<Array<{ manifest: { id: string; name?: string; permissions?: string[] } }>>('/api/apps');
  return apps
    .map((a) => ({ id: a.manifest.id, name: a.manifest.name ?? '', permissions: a.manifest.permissions ?? [] }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function registerPerm(app: Command): void {
  const perm = app
    .command('perm')
    .description(
      'Manage an app\'s manifest permissions[]. Note most permissions are still ' +
      'auto-granted by the MVP PermissionManager — only those in its ENFORCED set ' +
      '(currently apps.mount) actually deny.',
    );

  perm
    .command('ls [appId]')
    .alias('list')
    .description('Show declared permissions — for one app, or all apps.')
    .action(async (appId?: string) => {
      const apps = await fetchAppsWithPerms();
      const picked = appId ? apps.filter((a) => a.id === appId) : apps;
      if (picked.length === 0) fail(`App not found: ${appId}`);
      console.log(table(picked.map((a) => ({
        APP: a.id,
        PERMISSIONS: a.permissions.length ? a.permissions.join(', ') : color.dim('(none)'),
      }))));
    });

  perm
    .command('grant [appId] [permissions...]')
    .description(
      'Grant permissions. With no arguments, opens an interactive picker: choose ' +
      'an app, then check/uncheck its permissions (unchecking revokes).',
    )
    .action(async (appId?: string, permissions?: string[]) => {
      try {
        if (!appId || !permissions || permissions.length === 0) {
          await grantInteractive(appId);
          return;
        }
        for (const p of permissions) reportPerm(await editPerm(appId, 'add-permission', p), 'granted');
      } catch (err) {
        if (err instanceof PromptCancelled) { info('cancelled'); return; }
        throw err;
      }
    });

  perm
    .command('revoke <appId> <permissions...>')
    .description('Revoke one or more permissions from an app.')
    .action(async (appId: string, permissions: string[]) => {
      for (const p of permissions) reportPerm(await editPerm(appId, 'remove-permission', p), 'revoked');
    });
}

/**
 * Interactive grant. Mirrors `cap grant -i`: pick ONE app (unless given), then
 * check/uncheck against its current set. Unchecking revokes, so one screen is
 * the whole truth rather than an add-only list.
 */
async function grantInteractive(appIdArg?: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('Interactive grant needs a TTY. Pass arguments: `aura app perm grant <appId> <permission...>`.');
  }
  const apps = await fetchAppsWithPerms();
  let appId = appIdArg;

  if (!appId) {
    const picked = await promptChoice<string>(
      'Grant permissions to which app?',
      apps.map((a) => ({
        value: a.id,
        label: a.id,
        desc: a.permissions.length ? a.permissions.join(', ') : '(none)',
      })),
      0,
      { allowBack: true },
    );
    if (picked === BACK) { info('cancelled'); return; }
    appId = picked;
  }

  const target = apps.find((a) => a.id === appId);
  if (!target) fail(`App not found: ${appId}`);
  const current = new Set(target!.permissions);

  // Built-ins first, then anything the app declares that isn't a built-in, so a
  // custom permission is preserved rather than silently dropped on save.
  const names = [...BUILTIN_PERMISSIONS_LIST, ...target!.permissions.filter((p) => !BUILTIN_PERMISSIONS_LIST.includes(p))];
  const res = await promptMultiSelect<string>(
    `Permissions for ${color.bold(appId!)}   ${color.dim('(unchecking revokes)')}`,
    [{
      label: 'permissions',
      options: names.map((p) => ({
        value: p,
        label: p,
        tag: ENFORCED_PERMISSIONS.includes(p) ? color.green('enforced') : color.dim('mvp: auto'),
        desc: BUILTIN_PERMISSIONS_LIST.includes(p) ? '' : color.yellow('not a built-in'),
        initiallyChecked: current.has(p),
      })),
    }],
    0,
    { allowBack: true },
  );
  if (res === BACK) { info('cancelled'); return; }

  const next = new Set(res.selected);
  const toAdd    = [...next].filter((p) => !current.has(p));
  const toRemove = [...current].filter((p) => !next.has(p));
  if (toAdd.length === 0 && toRemove.length === 0) { info(`no change — ${appId} already declares exactly that set`); return; }

  // One request per change: manifest-edit has no bulk permission action, so a
  // failure partway leaves a partial set rather than rolling back.
  for (const p of toRemove) reportPerm(await editPerm(appId!, 'remove-permission', p), 'revoked');
  for (const p of toAdd)    reportPerm(await editPerm(appId!, 'add-permission', p), 'granted');
}
