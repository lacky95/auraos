import type { Command } from 'commander';
import { api } from '../lib/client.js';
import { readManifest } from '../lib/manifest.js';
import { color, fail, ok, stateColor, table, uptime } from '../lib/format.js';
import { enterProot } from '../lib/enter-proot.js';

interface AppInstanceDto {
  instanceId: string;
  appId: string;
  state: string;
  port: number | null;
  pid: number | null;
  startedAt: string | null;
}

interface AppDto {
  manifest: { id: string };
  instances: AppInstanceDto[];
}

export function registerInst(program: Command): void {
  const inst = program.command('inst').alias('instance').description('Manage individual app instances.');

  inst
    .command('list')
    .alias('ls')
    .option('-a, --app <appId>', 'Filter by app ID')
    .description('List running instances (optionally filtered to one app).')
    .action(async (opts: { app?: string }) => {
      if (opts.app) {
        const list = await api.get<AppInstanceDto[]>(`/api/apps/${encodeURIComponent(opts.app)}/instances`);
        printList(list);
      } else {
        const apps = await api.get<AppDto[]>('/api/apps');
        printList(apps.flatMap((a) => a.instances));
      }
    });

  inst
    .command('info <instanceId>')
    .description('Print full status for an instance: manifest, state, activities.')
    .action(async (instanceId: string) => {
      const dto = await api.get(`/api/instances/${encodeURIComponent(instanceId)}/status`);
      console.log(JSON.stringify(dto, null, 2));
    });

  inst
    .command('stop <instanceId>')
    .description('Stop one instance gracefully (runs onPause/onStop/onDestroy hooks).')
    .action(async (instanceId: string) => {
      await api.post(`/api/instances/${encodeURIComponent(instanceId)}/stop`);
      ok(`stopped ${instanceId}`);
    });

  inst
    .command('kill <instanceId>')
    .description('Force-kill one instance with SIGKILL (no lifecycle hooks).')
    .action(async (instanceId: string) => {
      await api.post(`/api/instances/${encodeURIComponent(instanceId)}/kill`);
      ok(`killed ${instanceId}`);
    });

  inst
    .command('pause <instanceId>')
    .description('Pause an instance (calls onPause).')
    .action(async (instanceId: string) => {
      await api.post(`/api/instances/${encodeURIComponent(instanceId)}/pause`);
      ok(`paused ${instanceId}`);
    });

  inst
    .command('resume <instanceId>')
    .description('Resume a paused instance (calls onResume).')
    .action(async (instanceId: string) => {
      await api.post(`/api/instances/${encodeURIComponent(instanceId)}/resume`);
      ok(`resumed ${instanceId}`);
    });

  inst
    .command('shell <instanceId>')
    .option('-c, --cmd <cmd>', 'Run a single command instead of an interactive shell')
    .description('Drop into an interactive shell inside the running PRoot of an instance (docker-exec-style).')
    .action(async (instanceId: string, opts: { cmd?: string }) => {
      const dto = await api.get<{ appId: string; port: number | null }>(
        `/api/instances/${encodeURIComponent(instanceId)}/status`,
      );
      if (!dto.appId) fail(`Instance not found: ${instanceId}`);
      const manifest = readManifest(dto.appId);
      if (!manifest) fail(`Manifest missing for ${dto.appId}`);
      enterProot(instanceId, dto.appId, dto.port, manifest.tools ?? [], opts.cmd);
    });

  inst
    .command('logs <instanceId>')
    .option('-f, --follow', 'Follow new log lines')
    .description('Tail recent log output for an instance (V1: stub).')
    .action((instanceId: string, opts: { follow?: boolean }) => {
      console.error(color.yellow(`inst logs — not yet implemented (V2 will buffer to /data/aura/state/logs/${instanceId}.log).`));
      void opts;
      process.exit(2);
    });
}

function printList(list: AppInstanceDto[]): void {
  const rows = list.map((i) => ({
    INSTANCE: i.instanceId,
    APP:      i.appId,
    STATE:    stateColor(i.state),
    PORT:     i.port?.toString() ?? '-',
    PID:      i.pid?.toString() ?? '-',
    UPTIME:   uptime(i.startedAt),
  }));
  console.log(table(rows, ['INSTANCE', 'APP', 'STATE', 'PORT', 'PID', 'UPTIME']));
}
