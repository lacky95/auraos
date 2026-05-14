import type { Command } from 'commander';
import { api, subscribeEvents } from '../lib/client.js';
import { color, stateColor, table, uptime } from '../lib/format.js';

interface AppInstanceDto {
  instanceId: string;
  appId: string;
  state: string;
  port: number | null;
  startedAt: string | null;
}

interface AppActivityDto {
  activityId: string;
  parentInstanceId: string;
}

interface AppDto {
  manifest: { id: string };
  instances: AppInstanceDto[];
  activities: AppActivityDto[];
}

async function renderPs(): Promise<void> {
  const apps = await api.get<AppDto[]>('/api/apps');
  const rows: Array<Record<string, string>> = [];
  for (const app of apps) {
    for (const inst of app.instances) {
      const acts = app.activities.filter((a) => a.parentInstanceId === inst.instanceId).length;
      rows.push({
        INSTANCE:   inst.instanceId,
        APP:        inst.appId,
        STATE:      stateColor(inst.state),
        PORT:       inst.port?.toString() ?? '-',
        ACTIVITIES: acts.toString(),
        UPTIME:     uptime(inst.startedAt),
      });
    }
  }
  console.log(table(rows, ['INSTANCE', 'APP', 'STATE', 'PORT', 'ACTIVITIES', 'UPTIME']));
}

export function registerPs(program: Command): void {
  program
    .command('ps')
    .description('List all running app instances (docker-ps-style table).')
    .option('-w, --watch', 'Re-render live on state changes (SSE-driven)')
    .action(async (opts: { watch?: boolean }) => {
      await renderPs();
      if (!opts.watch) return;
      console.log(color.dim('\nwatching… (Ctrl+C to exit)'));
      const stop = subscribeEvents('/api/apps/events', async () => {
        process.stdout.write('\x1b[2J\x1b[H');
        await renderPs();
        console.log(color.dim('\nwatching… (Ctrl+C to exit)'));
      });
      process.on('SIGINT', () => { stop(); process.exit(0); });
      await new Promise(() => undefined);
    });
}
