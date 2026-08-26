/**
 * One-shot KV bootstrap. Runs once per shell boot, AFTER `kvServer.start()`
 * and BEFORE `AppManager.init()` so apps and SSR see a populated store.
 *
 *   0. If a previous boot quarantined a Redis-format snapshot (see
 *      `quarantineSnapshot` in @aura/kv-store) and the store is still empty,
 *      restore it first — before any branch below seeds defaults over the top.
 *   1. If `os/theme` already exists in the KV → nothing to do; return.
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

import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
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

/** Dirs @aura/kv-store parks an unreadable Redis snapshot in, as `<dataDir>/kv.redis-<stamp>`. */
const QUARANTINE_PREFIX = 'kv.redis-';

/**
 * Generous, because the first run pulls a redis image to read the old format.
 * It blocks the first request exactly once in the lifetime of an install, and a
 * slow boot beats silently coming up with someone's desk reset to defaults.
 */
const RECOVER_TIMEOUT_MS = 240_000;

/**
 * Step 0: restore a quarantined Redis-format snapshot automatically.
 *
 * Ordering is the whole reason this lives here rather than staying manual.
 * `bootstrapKv` seeds defaults into an empty store, and those placeholders are
 * indistinguishable from real state on the next boot — so recovery has to land
 * BEFORE seeding, or the defaults win and the old data is stranded.
 *
 * Deliberately conservative:
 *   - no quarantine dir -> returns immediately, so a normal boot pays nothing
 *   - store already populated -> never runs, so it cannot overwrite live data
 *   - any failure is logged with the manual command and swallowed; restoring
 *     old state is never worth refusing to boot over
 */
async function recoverQuarantinedSnapshot(
  dataDir: string,
  kv: ReturnType<typeof defaultKv>,
): Promise<void> {
  let parked: string[] = [];
  try {
    parked = readdirSync(dataDir).filter((n) => n.startsWith(QUARANTINE_PREFIX)).sort();
  } catch {
    return; // dataDir unreadable — the caller has bigger problems
  }
  if (parked.length === 0) return;
  // Only ever into an empty store. After a successful recovery os/theme exists,
  // so this stays a cheap no-op even with the quarantine dir left in place.
  if (await kv.exists('os', 'theme')) return;

  const script = fileURLToPath(new URL('../../../../os/migrate-redis-to-valkey.mjs', import.meta.url));
  if (!existsSync(script)) {
    console.warn(`[KvBootstrap] quarantined snapshot ${parked.join(', ')} found, but ${script} is missing — restore it by hand.`);
    return;
  }

  console.log(
    `[KvBootstrap] quarantined Redis snapshot (${parked.join(', ')}) + empty store — restoring it now.\n` +
    `              This runs once per install and may take a minute the first time.`,
  );
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [script, 'recover'], {
      timeout: RECOVER_TIMEOUT_MS,
      encoding: 'utf8',
    });
    for (const line of stdout.trim().split('\n')) console.log(`              ${line}`);
    console.log('[KvBootstrap] recovery complete — continuing boot with the restored store.');
  } catch (err) {
    console.warn(
      `[KvBootstrap] automatic recovery FAILED: ${(err as Error).message}\n` +
      `              Nothing was deleted. Booting on defaults; retry by hand with:\n` +
      `                node os/migrate-redis-to-valkey.mjs recover`,
    );
  }
}

export async function bootstrapKv(opts: { dataDir?: string } = {}): Promise<void> {
  const kv = defaultKv();
  const dataDir = opts.dataDir ?? '/data';
  try {
    await recoverQuarantinedSnapshot(dataDir, kv);

    if (await kv.exists('os', 'theme')) {
      return;
    }

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
        console.warn(`[KvBootstrap] migrated to the KV but failed to rename ${settingsFile}: ${(err as Error).message}`);
      }
      console.log(`[KvBootstrap] migrated ${settingsFile} → KV (theme=${theme.themeIdDark}/${theme.themeIdLight}/${theme.colorMode}, ${Array.isArray((workspaces as { workspaces?: unknown[] }).workspaces) ? (workspaces as { workspaces: unknown[] }).workspaces.length : '?'} workspaces)`);
      return;
    }

    // Fresh install — no JSON, no KV state.
    await kv.set('os', 'theme', {
      themeIdDark:  ThemeManager.DEFAULT_THEME_ID_DARK,
      themeIdLight: ThemeManager.DEFAULT_THEME_ID_LIGHT,
      colorMode:    ThemeManager.DEFAULT_COLOR_MODE,
    });
    await kv.set('os', 'workspaces', DEFAULT_WORKSPACE_STATE);
    console.log('[KvBootstrap] no settings.json — seeded defaults into the KV');
  } finally {
    // Keymap is seeded independently from theme/workspaces so it survives the
    // early-return branches above (legacy migration, theme-already-exists).
    // Empty bindings + empty appOverlays means "use registry defaults".
    try {
      if (!(await kv.exists('os', 'keymap'))) {
        await kv.set('os', 'keymap', { bindings: {}, appOverlays: {} });
        console.log('[KvBootstrap] seeded empty os/keymap');
      }
    } catch (err) {
      console.warn(`[KvBootstrap] could not seed os/keymap: ${(err as Error).message}`);
    }
    // Viewport profiles used to be seeded here, but they moved to device
    // localStorage (`aura.os.viewport`) since they're per-device, not
    // per-account. See lib/viewportClient.
    await kv.close().catch(() => undefined);
  }
}
