import type { Command } from 'commander';
import { subscribeEvents } from '../lib/client.js';
import { color } from '../lib/format.js';

function match(filter: string | undefined, type: string): boolean {
  if (!filter) return true;
  if (filter.endsWith('*')) return type.startsWith(filter.slice(0, -1));
  return type === filter;
}

function ts(): string {
  return color.dim(new Date().toISOString().slice(11, 23));
}

export function registerEvents(program: Command): void {
  program
    .command('events')
    .description('Follow the OsEventBus SSE stream — live timeline of state changes.')
    .option('-f, --filter <pattern>', 'Event-type filter, e.g. "app:*", "theme:*", "activity:opened"')
    .action(async (opts: { filter?: string }) => {
      console.log(color.dim(`subscribing to /api/apps/events${opts.filter ? ` [filter=${opts.filter}]` : ''} (Ctrl+C to stop)`));
      const stop = subscribeEvents('/api/apps/events', (ev) => {
        const t = typeof ev['type'] === 'string' ? ev['type'] : 'unknown';
        if (!match(opts.filter, t)) return;
        const rest = { ...ev };
        delete (rest as Record<string, unknown>)['type'];
        console.log(`${ts()} ${color.cyan(t.padEnd(20))} ${JSON.stringify(rest)}`);
      }, (err) => {
        console.error(color.red(`stream error: ${err.message}`));
      });
      process.on('SIGINT', () => { stop(); process.exit(0); });
      await new Promise(() => undefined);
    });
}
