/**
 * The System Terminal's id and the session-host apps (D69, stream T): a leaf
 * with no imports, so the access policy (lib/access, loaded by the security
 * gate's route audit from a bare checkout) and the plain-ESM servers share
 * one list without pulling @aura/core. terminal-embed.mjs re-exports both.
 * Phase 5b (repeat audit N2) moves the system app ids into a core leaf.
 */
export const TERMINAL_APP_ID = 'com.aura.terminal';
/**
 * D69 (stream T): the apps whose instances are each ONE user's session host
 * (core homes/plan.ts TERMINAL_SESSION_APPS). Their upstreams are reached
 * only by a caller acting for the instance's user (lib/access/decide.ts
 * `sessionHostReachable`), and their instances and sessions are listed only
 * to that user. The one list for the shell's TS and plain-ESM sides.
 * @type {ReadonlySet<string>}
 */
export const SESSION_HOST_APPS = new Set([TERMINAL_APP_ID]);
