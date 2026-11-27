/**
 * Delete an installed app: the one path behind `POST /api/apps/<id>/remove`.
 * Kills every instance under markUninstalling (so the warm pool can't refill
 * mid-delete), then removes the app through the Nexus lifecycle, which also
 * retires its App Hosts.
 */
import { getAppManager } from '../app-manager/AppManager.js';
import { SystemAppRemovalError } from './NexusManager.js';
import { getNexusManager } from './singleton.js';

export async function removeInstalledApp(appId: string): Promise<{ removed: boolean; dest: string }> {
  const mgr = getAppManager();
  const scope = mgr.registry.getScopeId(appId);
  if (!scope) throw new Error(`App not installed: ${appId}`);
  // Before anything stops: a built-in app is never deleted (D1).
  if (scope === 'system') throw new SystemAppRemovalError(appId);
  mgr.markUninstalling(appId, true);
  try {
    try {
      await mgr.killAllForApp(appId);
    } catch (err) {
      console.warn(`[apps/remove] killAllForApp(${appId}) failed: ${(err as Error).message} — continuing`);
    }
    return await getNexusManager().removeFromScope(appId, scope);
  } finally {
    // Always unmark: a stale mark would suppress the warm pool for good.
    mgr.markUninstalling(appId, false);
  }
}
