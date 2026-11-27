/**
 * The built-in system apps the kernel and the shell name (philosophy audit
 * N2, #9; 5b): each id once, here. System-app identity is legitimate; a copy
 * of the id in another file is not. Everything else (which routes a system
 * app may call, what its instances are) is decided where it is enforced, by
 * these names. A contract leaf (Foundation): no imports. Published as
 * `@aura/core/system-apps` for the shell's plain-ESM server files.
 */

/** The System Terminal (D25, D58, D69). */
export const TERMINAL_APP_ID = 'com.aura.terminal';
/** The shell's own agent daemon. */
export const AURASHELLD_APP_ID = 'com.aura.aurashelld';
export const SETTINGS_APP_ID = 'com.aura.settings';
export const NEXUS_APP_ID = 'com.aura.nexus';

/** D69 (stream T): the apps whose instances are each ONE user's session host. Read through `isUserEnvironment`. */
const SESSION_HOST_APP_IDS: ReadonlySet<string> = new Set([TERMINAL_APP_ID]);

/**
 * D107 S1: whether an instance hosts a user's environment: it runs as its
 * owner's identity with its owner's Private Home, as that user's session
 * context (the `user-environment` execution context, homes/types.ts). The
 * one predicate the identity provider, the home request, the pool, the jump
 * guard and the session enders branch on; nothing else keys this on an app
 * id. The System Terminal's instances (D69), and (D107-a, D108 P9) an
 * instance whose effective home environment is `private` (the setup's
 * effective configuration, authorized by `home.private`): callers that know
 * it pass `homeEnvironment`; `{appId}` alone answers for the Terminal only.
 */
export function isUserEnvironment(instance: { appId: string; homeEnvironment?: 'app' | 'private' }): boolean {
  return SESSION_HOST_APP_IDS.has(instance.appId) || instance.homeEnvironment === 'private';
}

/** Apps that act for a user as the owner's agents (the shell relays their calls, D89 B4). */
export const OWNER_AGENT_APP_IDS: ReadonlySet<string> = new Set([TERMINAL_APP_ID, AURASHELLD_APP_ID]);

/**
 * Whether an instance id is one of `appId`'s instances: the app id itself or
 * `<appId>-<n>` (the kernel's naming). The one place outside AppManager that
 * reads the format.
 */
export function isInstanceIdOf(instanceId: string, appId: string): boolean {
  return instanceId === appId || instanceId.startsWith(`${appId}-`);
}
