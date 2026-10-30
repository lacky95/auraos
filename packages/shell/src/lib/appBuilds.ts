/**
 * Production builds of apps (core app-manager/appBuild.ts) from the shell:
 * the shared "build these apps, then switch their running instances" step
 * behind `POST /api/apps/<id>/build` / `aura build app`, and the background
 * pass that runs after Settings → About → Update / Rebuild.
 *
 * Builds run one at a time in throwaway containers (AppManager.buildApp).
 * Switching a running app to its new build means restarting it; windows come
 * back (restartWithActivities). Never restarted automatically:
 *   • at.oebb.opsconsole — it hosts agent sessions;
 *   • com.aura.terminal — live shell sessions (tmux) live in its containers;
 * both switch on their next start (new terminals, pool refills).
 */
import { existsSync, rmSync } from 'node:fs';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { restartWithActivities } from './appRestart.js';

export const KEEP_RUNNING = new Set(['at.oebb.opsconsole', 'com.aura.terminal']);
/** Left by os/boot.sh when a requested build (Update / Rebuild) ran this boot. */
export const APP_BUILD_MARKER = '/data/aura/boot/apps-build-requested';

type BuildResult = Awaited<ReturnType<core.AppManager['buildApp']>> & { restarted?: boolean; restartNote?: string };

/** Build `appIds` (sequentially), then optionally restart the ones that were built. */
export async function buildApps(appIds: string[], opts: { force?: boolean; restart?: boolean } = {}): Promise<BuildResult[]> {
  const mgr = core.getAppManager();
  const out: BuildResult[] = [];
  for (const appId of appIds) {
    const r: BuildResult = await mgr.buildApp(appId, { force: opts.force });
    if (r.built && opts.restart) {
      const running = mgr.getInstancesByApp(appId).some((i) => i.state === 'resumed' || i.state === 'started');
      if (!running) r.restartNote = 'not running — starts from the build next time';
      else if (KEEP_RUNNING.has(appId)) r.restartNote = 'kept running (live sessions) — switches on its next start';
      else {
        try { await restartWithActivities(appId); r.restarted = true; }
        catch (err) { r.restartNote = `restart failed: ${(err as Error).message}`; }
      }
    }
    out.push(r);
  }
  return out;
}

/** Apps whose next start would not use a current build but could. */
export function appsNeedingBuild(): string[] {
  const mgr = core.getAppManager();
  return mgr.getManifests()
    .filter((m) => mgr.isEnabled(m.id))
    .filter((m) => {
      const s = mgr.serveStateOf(m.id);
      return s?.mode === 'dev' && (s.reason === 'changed' || s.reason === 'no-build');
    })
    .map((m) => m.id);
}

/**
 * After an Update / Rebuild (os/boot.sh left APP_BUILD_MARKER): build every
 * changed app in the background — the desktop is already up — and switch the
 * running ones. Detached; never throws.
 */
export function scheduleAppBuildPass(delayMs = 20_000): void {
  if (!existsSync(APP_BUILD_MARKER)) return;
  setTimeout(() => {
    void (async () => {
      const todo = appsNeedingBuild();
      console.log(`[app-builds] pass after Update/Rebuild: ${todo.length ? todo.join(', ') : 'nothing to build'}`);
      try {
        const res = await buildApps(todo, { restart: true });
        const failed = res.filter((r) => !r.ok).map((r) => r.appId);
        console.log(`[app-builds] pass done: built ${res.filter((r) => r.built).length}, failed ${failed.length}${failed.length ? ` (${failed.join(', ')})` : ''}`);
      } catch (err) {
        console.warn(`[app-builds] pass failed: ${(err as Error).message}`);
      } finally {
        try { rmSync(APP_BUILD_MARKER, { force: true }); } catch { /* read-only */ }
      }
    })();
  }, delayMs);
}
