/**
 * One-shot KV bootstrap. Runs once per shell boot, AFTER `kvServer.start()`
 * and BEFORE `AppManager.init()` so apps and SSR see a populated store.
 *
 *   1. If `os/theme` already exists in Redis → nothing to do; return.
 *   2. Else if `/data/settings.json` exists → migrate every top-level
 *      field under `os/<field>`, then rename the file to `.migrated` so
 *      the next boot skips this branch.
 *   3. Else → seed defaults from `@aura/core`'s ThemeManager +
 *      DEFAULT_WORKSPACE_STATE so the first paint isn't blank.
 *
 * Idempotent: the `exists` guard short-circuits on every subsequent run.
 * Persistence (RDB+AOF) means subsequent boots see step 1 even after a
 * container restart, as long as `/data` survives.
 */

import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { defaultKv } from '@aura/kv-store';
import { DEFAULT_WORKSPACE_STATE, ThemeManager } from '@aura/core';

interface LegacySettingsState {
  themeIdDark?:  string;
  themeIdLight?: string;
  colorMode?:    'light' | 'dark' | 'auto';
  clockFormat?:  '12h' | '24h';
  locale?:       string;
  workspaces?:   unknown;
}

export async function bootstrapKv(opts: { dataDir?: string } = {}): Promise<void> {
  const kv = defaultKv();
  try {
    if (await kv.exists('os', 'theme')) {
      return;
    }

    const dataDir       = opts.dataDir ?? '/data';
    const settingsFile  = join(dataDir, 'settings.json');
    const migratedFile  = `${settingsFile}.migrated`;

    if (existsSync(settingsFile)) {
      let parsed: LegacySettingsState = {};
      try {
        parsed = JSON.parse(readFileSync(settingsFile, 'utf8')) as LegacySettingsState;
      } catch (err) {
        console.warn(`[KvBootstrap] settings.json present but unparseable, falling back to defaults: ${(err as Error).message}`);
      }

      const theme = {
        themeIdDark:  parsed.themeIdDark  ?? ThemeManager.DEFAULT_THEME_ID_DARK,
        themeIdLight: parsed.themeIdLight ?? ThemeManager.DEFAULT_THEME_ID_LIGHT,
        colorMode:    parsed.colorMode    ?? ThemeManager.DEFAULT_COLOR_MODE,
      };
      const workspaces = parsed.workspaces ?? DEFAULT_WORKSPACE_STATE;

      await kv.set('os', 'theme',       theme);
      await kv.set('os', 'workspaces',  workspaces);
      if (parsed.clockFormat) await kv.set('os', 'clockFormat', parsed.clockFormat);
      if (parsed.locale)      await kv.set('os', 'locale',      parsed.locale);

      try {
        renameSync(settingsFile, migratedFile);
      } catch (err) {
        // Rename failure isn't fatal — the exists() guard above prevents
        // duplicate migrations on the next boot. Surface the warning so the
        // operator notices and can clean up by hand.
        console.warn(`[KvBootstrap] migrated to Redis but failed to rename ${settingsFile}: ${(err as Error).message}`);
      }
      console.log(`[KvBootstrap] migrated ${settingsFile} → Redis (theme=${theme.themeIdDark}/${theme.themeIdLight}/${theme.colorMode}, ${Array.isArray((workspaces as { workspaces?: unknown[] }).workspaces) ? (workspaces as { workspaces: unknown[] }).workspaces.length : '?'} workspaces)`);
      return;
    }

    // Fresh install — no JSON, no Redis state.
    await kv.set('os', 'theme', {
      themeIdDark:  ThemeManager.DEFAULT_THEME_ID_DARK,
      themeIdLight: ThemeManager.DEFAULT_THEME_ID_LIGHT,
      colorMode:    ThemeManager.DEFAULT_COLOR_MODE,
    });
    await kv.set('os', 'workspaces', DEFAULT_WORKSPACE_STATE);
    console.log('[KvBootstrap] no settings.json — seeded defaults into Redis');
  } finally {
    await kv.close().catch(() => undefined);
  }
}
