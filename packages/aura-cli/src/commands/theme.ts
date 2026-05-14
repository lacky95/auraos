import type { Command } from 'commander';
import { api } from '../lib/client.js';
import { color, fail, ok } from '../lib/format.js';

const PROVIDER = '/api/data/com.aura.settings/api/data/theme';

interface ThemeResponse {
  themeId: string;
  theme?: { id: string; name: string };
}

export function registerTheme(program: Command): void {
  const theme = program.command('theme').description('Get / set the current AuraOS theme via the Settings content provider.');

  theme
    .command('list')
    .description('List available theme presets.')
    .action(async () => {
      try {
        const data = await api.get<{ themes: Array<{ id: string; name: string }> }>('/api/data/com.aura.settings/api/data/themes');
        const current = await api.get<ThemeResponse>(PROVIDER).catch(() => null);
        for (const t of data.themes ?? []) {
          const marker = current?.themeId === t.id ? color.green('●') : color.dim('○');
          console.log(`${marker} ${t.id.padEnd(12)} ${color.dim(t.name)}`);
        }
      } catch (err) {
        fail(`Could not list themes: ${(err as Error).message}`);
      }
    });

  theme
    .command('get')
    .description('Print the currently active theme ID.')
    .action(async () => {
      const res = await api.get<ThemeResponse>(PROVIDER);
      console.log(res.themeId);
    });

  theme
    .command('set <themeId>')
    .description('Set the active theme. Triggers a live update across the shell + open apps.')
    .action(async (themeId: string) => {
      await api.put(PROVIDER, { themeId });
      ok(`theme set to ${color.bold(themeId)}`);
    });
}
