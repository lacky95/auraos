/**
 * App composition (D104): one app's access to ANOTHER app, which the consuming
 * app requests and the owner grants. One grant model for every level:
 *
 *   subject   the consuming app (`{kind:'app', id}`), pinned to its installation
 *             (`GrantRecord.installationId`, as S1(b) pins every app grant)
 *   scope     the target app, pinned to its installation:
 *             `{kind:'app', id: <target appId>, installationId: <target's>}`
 *   permission  the access level
 *
 * Levels are independent grants; none implies another, so asking for a level
 * the app does not hold is always a fresh approval:
 *
 *   apps.view      read the target's pages and read-only API as the user, from
 *                  the consuming app's SERVER only (GET/HEAD, no socket, no
 *                  event stream, no AuraOS API through the target). Built.
 *   apps.embed     show the target's UI framed in the consuming app (reserved:
 *                  Phase 6, generalises `terminal.embed`, D25/5.16)
 *   apps.interact  act in the target for the user (reserved: beta)
 *
 * A grant counts only while BOTH installations are the current ones: a
 * reinstalled consumer or target has to be granted again (`appAccessCounts`).
 * The delegation credential (the restricted view cookie, shell app-hosts.mjs)
 * re-checks the grant on every request, so a revoke ends it at once.
 *
 * Targets are normal apps only (owner, 2026-11-27): never a system app, a
 * trusted system UI, an owner agent, or an app that shows the owner's Terminal
 * sessions. A target may opt out in its manifest (`composition.view: 'deny'`).
 *
 * Every refusal names what is missing and how to fix it (`appAccessError`),
 * in the one error body (errors/contracts.ts `AuraErrorBody`) the shell
 * answers and the SDK's `OsError` carries.
 *
 * Leaf contract: imports no other core module at runtime.
 */
import type { AuraErrorBody, ErrorCategory } from '../errors/contracts.js';
import type { GrantScope } from './types.js';

export const APP_VIEW_PERMISSION = 'apps.view';
/** The levels that can be granted today. */
export const APP_ACCESS_PERMISSIONS = [APP_VIEW_PERMISSION] as const;
/** Named by D104, not grantable yet: a request for them is refused with a hint. */
export const RESERVED_APP_ACCESS_PERMISSIONS = ['apps.embed', 'apps.interact'] as const;
export type AppAccessPermission = typeof APP_ACCESS_PERMISSIONS[number];

export function isAppAccessPermission(p: string): p is AppAccessPermission {
  return (APP_ACCESS_PERMISSIONS as readonly string[]).includes(p);
}

/** The grant scope of one target app's installation. */
export const appTargetScope = (appId: string, installationId: string): GrantScope => ({ kind: 'app', id: appId, installationId });

/** Where the docs explain it: the Aura Docs page "App composition" (anchor per refusal). */
export const APP_COMPOSITION_DOCS = '/docs/app-composition';

/**
 * Permissions whose holder shows or drives the owner's System Terminal: an
 * app that requests one is never a target (it would pass the owner's
 * sessions on).
 */
const TERMINAL_PERMISSIONS = new Set(['terminal.embed', 'terminal.sessions.list', 'terminal.screen.read']);

/** Lifetime of a delegation credential (the view cookie); re-minted by the SDK. */
export const APP_VIEW_CREDENTIAL_TTL_MS = 10 * 60 * 1000;
/** The longest one delegated read may stream: a revoke ends what is in flight by then. */
export const APP_VIEW_RESPONSE_MAX_MS = 60_000;

/** The header the router sets on a delegated request (the target can refuse it); never from a client. */
export const APP_ACCESS_HEADER = 'x-aura-access';
/** The consuming app of a delegated request. */
export const APP_ACCESS_BY_HEADER = 'x-aura-access-by';

export type AppAccessErrorCode =
  | 'server-only' | 'no-user' | 'not-declared' | 'not-granted' | 'denied' | 'grant-stale' | 'level-not-available'
  | 'target-unknown' | 'target-self' | 'target-not-allowed' | 'target-opted-out' | 'target-no-app-host'
  | 'invalid-request' | 'revoked' | 'read-only' | 'not-through-target';

/**
 * A refusal: the one error body (errors/contracts.ts, error-messages review
 * §4.1) plus its status. `error` is the closed code clients branch on
 * (`access-denied`, `not-found`, `invalid-request`, `conflict`), `reason` the
 * access reason, `category` what a client can do about it (missing-declaration:
 * the consumer's manifest; missing-permission: the owner's grant;
 * not-grantable: nobody can grant it), and `details.refusal` the exact D104 case.
 */
export interface AppAccessError extends AuraErrorBody {
  details: { refusal: AppAccessErrorCode };
  status: number;
}

export interface AppAccessErrorContext {
  permission?: string;
  consumer?: string;
  /** The consuming app's name for the sentence, else its id. */
  consumerName?: string;
  /** The target, only as the caller named it. */
  target?: string;
  /** Why a target is not allowed (`appAccessTargetRefusal`). */
  reason?: string;
}

/** What a client can do about each refusal (errors/contracts.ts ErrorCategory). */
const CATEGORY: Record<AppAccessErrorCode, ErrorCategory> = {
  'server-only': 'not-grantable', 'no-user': 'not-grantable', 'not-declared': 'missing-declaration',
  'not-granted': 'missing-permission', denied: 'missing-permission', 'grant-stale': 'missing-permission', revoked: 'missing-permission',
  'level-not-available': 'unsupported-feature', 'target-unknown': 'not-found', 'target-self': 'invalid-request',
  'target-not-allowed': 'not-grantable', 'target-opted-out': 'not-grantable', 'target-no-app-host': 'conflict',
  'invalid-request': 'invalid-request', 'read-only': 'not-grantable', 'not-through-target': 'not-grantable',
};

/** The grant command, the one fix the owner can always run (never offered for owner-only targets). */
export const appAccessGrantCommand = (consumer: string, permission: string, target: string): string =>
  `aura grant perms ${consumer} ${permission} --target ${target}`;

/**
 * The refusal for `code`: what is missing (the manifest field or the
 * permission, and who must hold it) and the command or approval that fixes
 * it. Hint rules (review §4.4): the target only as the caller named it, no
 * grant command for a target apps can never be granted, no internal paths.
 */
export function appAccessError(code: AppAccessErrorCode, ctx: AppAccessErrorContext = {}): AppAccessError {
  const permission = ctx.permission ?? APP_VIEW_PERMISSION;
  const consumer = ctx.consumer ?? '<app>';
  const who = ctx.consumerName ?? consumer;
  const target = ctx.target ?? '<target app>';
  const grant = appAccessGrantCommand(consumer, permission, target);
  const out = (
    status: number, error: string, reason: string | undefined, message: string, hint: string,
    facts: Pick<AuraErrorBody, 'holder' | 'manifestField'> = {},
  ): AppAccessError => ({
    error, message, ...(reason ? { reason } : {}), category: CATEGORY[code], hint, docs: `${APP_COMPOSITION_DOCS}#${code}`,
    permission, ...facts, ...(ctx.target ? { target: ctx.target } : {}), details: { refusal: code }, status,
  });
  switch (code) {
    case 'server-only':
      return out(403, 'access-denied', 'wrong-principal', `${permission} is used by an app's server only: its credential never goes to a page.`,
        'Call it from your app\'s server with its own instance token (osClient.apps.view(...) on the server).');
    case 'no-user':
      return out(403, 'access-denied', 'wrong-principal', `${who} acts for no user here, so it can read nothing of ${target} for one.`,
        'Call it from an instance that runs for a user (an ordinary app instance does).');
    case 'not-declared':
      return out(403, 'access-denied', 'missing-permission',
        `${who} lacks permission '${permission}' for ${target}: its app.manifest.json does not declare it in permissions[].`,
        `Add "${permission}" to permissions[] in ${consumer}'s app.manifest.json; then approve the request in AuraOS, or the owner runs: ${grant}`,
        { holder: 'caller', manifestField: 'permissions[]' });
    case 'not-granted':
      return out(403, 'access-denied', 'approval-required', `${who} requests '${permission}' for ${target}, but the owner has not granted it.`,
        `Approve the request in the AuraOS dialog, or the owner runs: ${grant}`, { holder: 'owner-grant' });
    case 'denied':
      return out(403, 'access-denied', 'approval-required', `The owner did not grant ${who} '${permission}' for ${target}.`,
        `Ask again later (a new request opens the dialog again), or the owner runs: ${grant}`, { holder: 'owner-grant' });
    case 'grant-stale':
      return out(403, 'access-denied', 'approval-required',
        `${who}'s '${permission}' grant for ${target} was given to an earlier installation of one of them, so it no longer counts.`,
        `Approve the new request, or the owner runs again: ${grant}`, { holder: 'owner-grant' });
    case 'level-not-available':
      return out(400, 'invalid-request', undefined, `'${permission}' is not available yet: only apps.view can be granted (apps.embed and apps.interact are planned, D104).`,
        'Use apps.view to read; open the target as its own window (an intent) to work in it.');
    case 'target-unknown':
      return out(404, 'not-found', undefined, `No app ${target} is installed.`, 'Name an installed app by its id, or an App Host address of one.');
    case 'target-self':
      return out(400, 'invalid-request', undefined, `${who} names itself: it reads its own pages without ${permission}.`, 'Name another app.');
    case 'target-not-allowed':
      return out(403, 'access-denied', 'wrong-target', `${target} is the owner's (${ctx.reason ?? 'not a normal app'}): apps can't be granted ${permission} for it.`,
        'Open it as its own window instead (an intent).');
    case 'target-opted-out':
      return out(403, 'access-denied', 'wrong-target', `${target} refuses delegated access: its app.manifest.json declares composition.view "deny".`,
        `Only ${target}'s developer can change this (composition.view in its app.manifest.json).`,
        { holder: 'target', manifestField: 'composition.view' });
    case 'target-no-app-host':
      return out(409, 'conflict', undefined, `${target} has no App Host to read (a service, or no address yet).`,
        'Open the target once from the desktop so it gets its address, or name an app with a window.');
    case 'invalid-request':
      return out(400, 'invalid-request', undefined, `This ${permission} request names no usable target: give {appId, desktop} or {host}.`,
        'Pass the target app id and your desktop host (appHostUrlFromRequest gives it), or the target\'s App Host address.');
    case 'revoked':
      return out(403, 'access-denied', 'approval-required', `${who}'s '${permission}' for ${target} was revoked, expired or no longer counts.`,
        `Request it again (osClient.apps.view asks the owner), or the owner runs: ${grant}`, { holder: 'owner-grant' });
    case 'read-only':
      return out(403, 'access-denied', 'rule-denied', `${permission} is read-only: GET and HEAD only, no WebSocket and no event stream into ${target}.`,
        'Read with GET or HEAD. Changing the target needs apps.interact, which is not available yet (D104).');
    case 'not-through-target':
      return out(403, 'access-denied', 'rule-denied', `${permission} reaches ${target}'s own pages and API, not AuraOS's API through it.`,
        'Ask AuraOS directly with your own instance token for what your app may do.');
  }
}

/** The JSON body of a refusal (no status). */
export function appAccessErrorBody(e: AppAccessError): AuraErrorBody {
  const { status: _status, ...body } = e;
  return body;
}

/** What a target check needs to know about an app. */
export interface AppAccessTargetFacts {
  /** The target's manifest, or undefined when no app has that id. */
  manifest: { id: string; componentType?: string; permissions?: readonly string[]; composition?: { view?: string } } | undefined;
  /** The install scope its id resolves to (`system`, `global`, `user`). */
  scope: string | undefined;
  /**
   * Why the shell keeps this app out of reach of other apps by id (a trusted
   * system UI, D45; an owner agent, D29), or null.
   */
  protectedBy: string | null;
}

/**
 * Why `target` can't be a target of `consumer`'s `permission`, as a refusal,
 * or null. Normal apps only: never a system app, a trusted system UI, an owner
 * agent or an app that shows the owner's Terminal sessions; never itself; not
 * an app that opted out; only an app with a window.
 */
export function appAccessTargetRefusal(
  consumer: string, target: string, facts: AppAccessTargetFacts, ctx: Omit<AppAccessErrorContext, 'target' | 'consumer' | 'reason'> = {},
): AppAccessError | null {
  const base = { ...ctx, consumer, target };
  const m = facts.manifest;
  if (!m) return appAccessError('target-unknown', base);
  if (target === consumer) return appAccessError('target-self', base);
  if (facts.scope === 'system') return appAccessError('target-not-allowed', { ...base, reason: 'it is a system app' });
  if (facts.protectedBy) return appAccessError('target-not-allowed', { ...base, reason: facts.protectedBy });
  if ((m.permissions ?? []).some((p) => TERMINAL_PERMISSIONS.has(p))) {
    return appAccessError('target-not-allowed', { ...base, reason: 'it shows the owner\'s Terminal sessions (it requests a terminal.* permission)' });
  }
  if (m.componentType === 'service') return appAccessError('target-no-app-host', base);
  if (m.composition?.view === 'deny') return appAccessError('target-opted-out', base);
  return null;
}

/**
 * Whether an app-access grant counts: given to the consumer's current
 * installation (and install scope), for the target's current installation.
 */
export function appAccessCounts(
  record: { appScope?: string; installationId?: string | null; scope?: GrantScope } | null,
  consumer: { scope?: string; installationId: string | null },
  targetInstallationId: string | null,
): boolean {
  if (!record || !consumer.installationId || !targetInstallationId) return false;
  if (record.appScope && consumer.scope && record.appScope !== consumer.scope) return false;
  if (record.installationId !== consumer.installationId) return false;
  return record.scope?.kind === 'app' && record.scope.installationId === targetInstallationId;
}
