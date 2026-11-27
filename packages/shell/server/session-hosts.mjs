/**
 * The System Terminal's id and the session-host apps (D69, stream T): a leaf
 * with no imports, so the access policy (lib/access, loaded by the security
 * gate's route audit from a bare checkout) and the plain-ESM servers share
 * one list without pulling @aura/core. terminal-embed.mjs re-exports both.
 * The kernel names the same ids in its Foundation leaf (core
 * system/systemApps.ts, `@aura/core/system-apps`, audit N2); this is the
 * shell's copy for code that must load without the workspace packages, and
 * shell test/session-hosts.test.ts keeps the two equal. Edit both together.
 */
export const TERMINAL_APP_ID = 'com.aura.terminal';
/**
 * D69 (stream T): the apps whose instances are each ONE user's session host
 * (core system/systemApps.ts `isUserEnvironment`, D107 S1). Their upstreams are reached
 * only by a caller acting for the instance's user (lib/access/decide.ts
 * `sessionHostReachable`), and their instances and sessions are listed only
 * to that user. The one list for the shell's TS and plain-ESM sides.
 * @type {ReadonlySet<string>}
 */
export const SESSION_HOST_APPS = new Set([TERMINAL_APP_ID]);

/** The shell's own agent daemon. */
export const AURASHELLD_APP_ID = 'com.aura.aurashelld';
/** The Settings app. */
export const SETTINGS_APP_ID = 'com.aura.settings';
/** Apps that act for a user as the owner's agents (the shell relays their calls, D89 B4). */
export const OWNER_AGENT_APPS = new Set([TERMINAL_APP_ID, AURASHELLD_APP_ID]);

/**
 * Whether an instance id is one of `appId`'s instances: the app id itself or
 * `<appId>-<n>` (the kernel's naming; core `isInstanceIdOf`).
 * @param {string} instanceId
 * @param {string} appId
 */
export function isInstanceIdOf(instanceId, appId) {
  return instanceId === appId || instanceId.startsWith(`${appId}-`);
}
