/**
 * The answer to a window or flight close (D101): core's ActivityCloseResult,
 * plus the app installation the user's remembered choice is kept under when
 * a background process stays behind (lib/lastWindow.ts). Server side.
 */
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import type { ActivityCloseResult } from '@aura/core';

export interface ActivityCloseAnswer extends ActivityCloseResult {
  /** The app's App Host installation (scope of the running copy), when it stays running and has one. */
  installationId?: string;
}

/** The installation of a running app's copy, or null (no App Host installation, or the registry is not up). */
async function installationOf(appId: string): Promise<string | null> {
  try {
    const app = core.getAppManager().registry.getById(appId) as { scopeId?: string } | undefined;
    if (!app?.scopeId) return null;
    return (await core.getAppHostServices().registry.findInstallation(appId, app.scopeId))?.installationId ?? null;
  } catch {
    return null;
  }
}

/** Only a close that leaves a running instance behind needs the installation. */
export async function describeClose(
  r: ActivityCloseResult,
  lookup: (appId: string) => Promise<string | null> = installationOf,
): Promise<ActivityCloseAnswer> {
  if (!r.closed || !r.lastOfInstance || !r.instanceRunning || !r.appId) return r;
  const installationId = await lookup(r.appId);
  return installationId ? { ...r, installationId } : r;
}
