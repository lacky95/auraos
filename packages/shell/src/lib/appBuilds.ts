/**
 * Production builds of apps (core app-manager/appBuild.ts) from the shell:
 * the shared "build these apps, then switch their running instances" step
 * behind `POST /api/apps/<id>/build` / `aura build app`, and the background
 * pass that runs after Settings → About → Update / Rebuild.
 *
 * Builds run one at a time in throwaway containers (AppManager.buildApp).
 * Switching a running app to its new build means restarting it; windows come
 * back (restartWithActivities). Never restarted automatically: an app whose
 * manifest declares `keepRunningOnBuild` (live sessions a restart would end,
 * e.g. the System Terminal's tmux sessions); it switches on its next start
 * (new terminals, pool refills).
 *
 * A Rebuild can change the SDK, so the pass first publishes it to the local
 * registry and refreshes the registry copies of installed apps; the build
 * fingerprint (appFingerprint) then marks whoever uses it as changed.
 */
import { existsSync, rmSync } from 'node:fs';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { restartWithActivities } from './appRestart.js';
import { ensureSdkPublished } from './sdkBootstrap.js';

/** The app's manifest asks to keep its running instances across a build (`keepRunningOnBuild`). */
export const keepsRunning = (appId: string): boolean => core.getAppManager().getManifest(appId)?.keepRunningOnBuild === true;
/** Left by os/boot.sh when a requested build (Update / Rebuild) ran this boot. */
export const APP_BUILD_MARKER = '/data/aura/boot/apps-build-requested';

type BuildResult = Awaited<ReturnType<core.AppManager['buildApp']>> & { restarted?: boolean; restartNote?: string };

const isRunning = (appId: string) =>
  core.getAppManager().getInstancesByApp(appId).some((i) => i.state === 'resumed' || i.state === 'started');

/** Move a running app onto what is now on disk, unless it must keep running. */
async function switchRunning(appId: string): Promise<Pick<BuildResult, 'restarted' | 'restartNote'>> {
  if (!isRunning(appId)) return { restartNote: 'not running — starts from the build next time' };
  if (keepsRunning(appId)) return { restartNote: 'kept running (live sessions) — switches on its next start' };
  try { await restartWithActivities(appId); return { restarted: true }; }
  catch (err) { return { restartNote: `restart failed: ${(err as Error).message}` }; }
}

/** Build `appIds` (sequentially), then optionally restart the ones that were built. */
export async function buildApps(appIds: string[], opts: { force?: boolean; restart?: boolean } = {}): Promise<BuildResult[]> {
  const mgr = core.getAppManager();
  const out: BuildResult[] = [];
  for (const appId of appIds) {
    const r: BuildResult = await mgr.buildApp(appId, { force: opts.force });
    if (r.built && opts.restart) Object.assign(r, await switchRunning(appId));
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
 * Refresh the registry @aura/* copies of enabled apps. A running
 * `keepRunningOnBuild` app is left alone: its live process still loads from that copy.
 * Returns the apps whose packages actually changed.
 */
async function refreshAppSdks(): Promise<string[]> {
  const mgr = core.getAppManager();
  const changed: string[] = [];
  for (const m of mgr.getManifests()) {
    if (!mgr.isEnabled(m.id) || (m.keepRunningOnBuild && isRunning(m.id))) continue;
    const r = await mgr.refreshSdk(m.id);
    if (r.warning) console.warn(`[app-builds] ${m.id}: ${r.warning}`);
    if (r.changed) changed.push(m.id);
  }
  return changed;
}

/**
 * After an Update / Rebuild (os/boot.sh left APP_BUILD_MARKER): publish the
 * SDK, refresh installed apps' copies, build every changed app in the
 * background — the desktop is already up — and switch the running ones.
 * Detached; never throws.
 */
export function scheduleAppBuildPass(delayMs = 20_000): void {
  if (!existsSync(APP_BUILD_MARKER)) return;
  setTimeout(() => {
    void (async () => {
      try {
        // Awaited: the refresh below must see this boot's packages in the registry.
        await ensureSdkPublished();
        const refreshed = await refreshAppSdks();
        const todo = appsNeedingBuild();
        console.log(`[app-builds] pass after Update/Rebuild: ${todo.length ? todo.join(', ') : 'nothing to build'}`);
        const res = await buildApps(todo, { restart: true });
        // New SDK but nothing to build (apps on astro dev or their own entrypoint).
        for (const appId of refreshed.filter((id) => !todo.includes(id))) {
          const { restartNote } = await switchRunning(appId);
          if (restartNote?.startsWith('restart failed')) console.warn(`[app-builds] ${appId}: ${restartNote}`);
        }
        const failed = res.filter((r) => !r.ok);
        for (const r of failed) console.warn(`[app-builds] ${r.appId} failed: ${core.buildFailureReason(r)}`);
        console.log(`[app-builds] pass done: built ${res.filter((r) => r.built).length}, failed ${failed.length}${failed.length ? ` (${failed.map((r) => r.appId).join(', ')})` : ''}`);
      } catch (err) {
        console.warn(`[app-builds] pass failed: ${(err as Error).message}`);
      } finally {
        try { rmSync(APP_BUILD_MARKER, { force: true }); } catch { /* read-only */ }
      }
    })();
  }, delayMs);
}
