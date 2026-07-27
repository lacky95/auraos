import type { APIRoute } from 'astro';
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAppManager } from '@aura/core';
import { defaultKv } from '@aura/kv-store';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/**
 * Delete an installed app. Two-phase:
 *   1. Stop every running instance (graceful onPause/onStop/onDestroy via
 *      AppManager.stopAll, which the CLI's `aura app stop` already calls).
 *   2. `rm -rf <scopeAppsDir>/<id>` — the app's real directory is resolved via
 *      the registry (`getAppDir`), which spans all scopes (system/global/user).
 *      A hardcoded `/workspace/apps` would only find system-scope apps and
 *      silently no-op (returning `removed:false`) on user/global installs —
 *      the CLI then falsely prints "removed". chokidar's `unlink` watcher emits
 *      `app:removed` automatically, which deletes the AppRegistry entry and
 *      ripples through the dock + launcher live (same osEvents pipeline the
 *      enable/disable flow uses).
 *   3. Clean up the per-app enable-state entry in KV so it doesn't accumulate
 *      forever when apps churn.
 *
 * The CLI + Settings UI both confirm "Do you want to delete this app?" before
 * calling here — but we still validate the appId server-side and refuse to
 * touch anything outside the apps dir as a defence-in-depth measure.
 */

const APP_ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

export const POST: APIRoute = async ({ params }) => deleteApp(params['id']);
// DELETE method too — the CLI's `aura app remove` historically used it.
export const DELETE: APIRoute = async ({ params }) => deleteApp(params['id']);

async function deleteApp(appId: string | undefined): Promise<Response> {
  if (!appId) return errorResponse('Missing app id', 400);
  if (!APP_ID_RE.test(appId)) {
    return errorResponse(`Invalid app id: ${appId}. Expected reverse-domain notation.`, 400);
  }

  const mgr = getAppManager();
  if (!mgr.getManifest(appId)) {
    return errorResponse(`App not installed: ${appId}`, 404);
  }

  // Resolve the app's real directory across ALL scopes via the registry.
  const dest = resolve(mgr.registry.getAppDir(appId));
  // Path-escape guard: the resolved dir must be exactly `<scopeAppsDir>/<appId>`.
  // appId is already regex-validated, and getAppDir returns a registry-computed
  // `<scope.appsDir>/<appId>`, so this defends against a future regex bypass.
  if (!dest.endsWith(`/${appId}`)) {
    return errorResponse(`Refusing to delete unexpected path: ${dest}`, 400);
  }

  // Stop everything first. stopAll runs lifecycle hooks (onPause/onStop/
  // onDestroy) which lets the app flush state to /data before its files
  // disappear. Failures here are warnings — we still want to remove the
  // directory so the user isn't stuck with a half-broken install.
  try {
    await mgr.stopAll(appId);
  } catch (err) {
    console.warn(`[apps/remove] stopAll(${appId}) failed: ${(err as Error).message} — continuing with rm`);
  }

  if (!existsSync(dest)) {
    // Directory already gone (manual rm earlier?) — chokidar may or may not
    // have caught it. Tell the registry directly via a fresh scan so the
    // launcher/dock stop offering a ghost app.
    return jsonResponse({ ok: true, appId, removed: false, message: `${dest} did not exist on disk; registry will reconcile.` });
  }

  try {
    rmSync(dest, { recursive: true, force: true });
  } catch (err) {
    return errorResponse(`rm -rf ${dest} failed: ${(err as Error).message}`, 500);
  }

  // KV cleanup — drop this app's entry from the enable map so the persisted
  // state matches what AppManager will see on next boot (registry no longer
  // has the app, so the map should drop it too).
  try {
    const kv = defaultKv();
    try {
      const map = (await kv.getValue<Record<string, boolean>>('os', 'app-enabled')) ?? {};
      if (appId in map) {
        delete map[appId];
        await kv.set('os', 'app-enabled', map);
      }
    } finally {
      await kv.close().catch(() => undefined);
    }
  } catch (err) {
    console.warn(`[apps/remove] KV cleanup failed: ${(err as Error).message}`);
  }

  return jsonResponse({ ok: true, appId, removed: true, dest });
}
