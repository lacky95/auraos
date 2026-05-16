import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { api } from '../lib/client.js';
import { color, fail, info, ok, table } from '../lib/format.js';
import { promptConfirm, PromptCancelled } from '../lib/prompts.js';

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
}
