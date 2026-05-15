import type { Command } from 'commander';
import { api } from '../lib/client.js';
import { color, fail, ok } from '../lib/format.js';

const KV_THEME    = '/api/kv/os/theme';
const OS_THEMES   = '/api/os/themes';

interface KvEnvelope<T> { value: T; updatedAt: number; }
interface ThemeSelection { themeIdDark?: string; themeIdLight?: string; colorMode?: 'light' | 'dark' | 'auto' }

export function registerTheme(program: Command): void {
  const theme = program.command('theme').description('Get / set the current AuraOS theme via the OS KV.');

  theme
    .command('list')
    .description('List available theme presets.')
    .action(async () => {
      try {
        const data    = await api.get<{ themes: Array<{ id: string; name: string; tone?: string }> }>(OS_THEMES);
        const current = await api.get<KvEnvelope<ThemeSelection>>(KV_THEME).catch(() => null);
        const activeDark  = current?.value?.themeIdDark  ?? null;
        const activeLight = current?.value?.themeIdLight ?? null;
        for (const t of data.themes ?? []) {
          const active = t.id === activeDark || t.id === activeLight;
          const marker = active ? color.green('●') : color.dim('○');
          console.log(`${marker} ${t.id.padEnd(12)} ${color.dim(t.name)}`);
        }
      } catch (err) {
        fail(`Could not list themes: ${(err as Error).message}`);
      }
    });

  theme
    .command('get')
    .description('Print the currently active theme selection.')
    .action(async () => {
      const res = await api.get<KvEnvelope<ThemeSelection>>(KV_THEME);
      const v = res.value ?? {};
      console.log(`dark:  ${v.themeIdDark  ?? '(none)'}`);
      console.log(`light: ${v.themeIdLight ?? '(none)'}`);
      console.log(`mode:  ${v.colorMode    ?? '(none)'}`);
    });

  theme
    .command('set <themeId>')
    .description('Set the active dark theme. Triggers a live update across the shell + open apps.')
    .option('--tone <tone>', "'dark' or 'light' — which slot to update", 'dark')
    .action(async (themeId: string, opts: { tone: 'dark' | 'light' }) => {
      // Read-modify-write: KV PUT replaces the whole value.
      const current = await api.get<KvEnvelope<ThemeSelection>>(KV_THEME).catch(() => null);
      const previous = current?.value ?? {};
      const field = opts.tone === 'light' ? 'themeIdLight' : 'themeIdDark';
      await api.put(KV_THEME, { value: { ...previous, [field]: themeId } });
      ok(`${opts.tone} theme set to ${color.bold(themeId)}`);
    });
}
