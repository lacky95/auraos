import type { Command } from 'commander';
import { api } from '../lib/client.js';
import { color, ok, table } from '../lib/format.js';

interface ActivityDto {
  activityId: string;
  parentInstanceId: string;
  appId: string;
  path: string;
  title?: string;
}

export function registerActivity(program: Command): void {
  const act = program.command('activity').alias('act').description('Manage app activities (UI screens).');

  act
    .command('list')
    .alias('ls')
    .option('-i, --instance <instanceId>', 'Filter by parent instance ID')
    .description('List activities (optionally for one instance only).')
    .action(async (opts: { instance?: string }) => {
      let activities: ActivityDto[];
      if (opts.instance) {
        activities = await api.get<ActivityDto[]>(`/api/instances/${encodeURIComponent(opts.instance)}/activities`);
      } else {
        const apps = await api.get<Array<{ activities: ActivityDto[] }>>('/api/apps');
        activities = apps.flatMap((a) => a.activities);
      }
      const rows = activities.map((a) => ({
        ACTIVITY: a.activityId,
        INSTANCE: a.parentInstanceId,
        APP:      a.appId,
        PATH:     a.path,
        TITLE:    a.title ?? '-',
      }));
      console.log(table(rows, ['ACTIVITY', 'INSTANCE', 'APP', 'PATH', 'TITLE']));
    });

  act
    .command('open <instanceId>')
    .option('-d, --data <json>', 'Optional JSON object passed to the app\'s onActivityCreate hook')
    .description('Open a new activity on a running instance.')
    .action(async (instanceId: string, opts: { data?: string }) => {
      let data: Record<string, unknown> | undefined;
      if (opts.data) {
        try { data = JSON.parse(opts.data) as Record<string, unknown>; }
        catch { console.error('Invalid --data JSON'); process.exit(1); }
      }
      const res = await api.post<{ activityId: string }>(`/api/instances/${encodeURIComponent(instanceId)}/activities`, data);
      ok(`opened ${color.bold(res.activityId)}`);
    });

  act
    .command('close <activityId>')
    .description('Close an activity. If it was the last and the app is not a backgroundService, the instance stops too.')
    .action(async (activityId: string) => {
      await api.post(`/api/activities/${encodeURIComponent(activityId)}/close`);
      ok(`closed ${activityId}`);
    });
}
