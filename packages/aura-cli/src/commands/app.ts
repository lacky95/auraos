import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { api } from '../lib/client.js';
import { color, ok, table } from '../lib/format.js';

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
      }));
      console.log(table(rows, ['ID', 'NAME', 'VERSION', 'INSTANCES', 'MODE', 'BG']));
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
    .description('Stop and remove an installed app from disk.')
    .action(async (appId: string) => {
      await api.del(`/api/apps/${encodeURIComponent(appId)}`);
      ok(`removed ${appId}`);
    });
}
