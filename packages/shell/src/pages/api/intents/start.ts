import type { APIRoute } from 'astro';
import { auraErrorOf, getAppManager, IntentError } from '@aura/core';
import { jsonResponse, errorResponse, failureResponse } from '../../../lib/appResponse.js';
import { isOwnerCaller, verifiedAppCaller } from '../../../lib/terminalCaller.ts';
import { appHostViewTarget } from '../../../lib/appHostIntent.ts';
import {
  OPEN_TERMINAL_ACTION, TERMINAL_APP_ID, grantSession, isSystemTerminal, openTerminalNeedsProof, openTerminalRefusal,
  terminalSessionInstance,
} from '../../../../server/terminal-embed.mjs';
import { explicitTargetRefusal } from '../../../lib/intentTarget.ts';
import { requestUserId } from '../../../lib/userContext.js';

interface IntentBody {
  action?:   unknown;
  appId?:    unknown;
  category?: unknown;
  type?:     unknown;
  uri?:      unknown;
  extras?:   unknown;
  instanceId?: unknown;
  flags?:    unknown;
}

/**
 * Resolve + start an intent. Body shape mirrors `Intent` from @aura/core
 * (action required; appId/category/type/uri/extras/instanceId/flags optional —
 * `appId` makes it an explicit intent that skips resolution, `instanceId`
 * targets one running instance, `flags: ['NEW_INSTANCE']` asks for a fresh
 * one). Returns either:
 *   { kind: 'started', appId, instanceId, activityId?, intentDelivered, result? }
 *                                                         — single handler picked; the intent
 *                                                           went to onActivityCreate (multi) or
 *                                                           onIntent (everything else). No
 *                                                           activityId = handled window-less;
 *                                                           `result` = what the handler returned
 *   { kind: 'rejected', appId, instanceId, code, message, hint? }
 *                                                         — the handler declined it (4xx, its status)
 *   { kind: 'disambiguation', candidates: [...] }         — shell should pick one
 *   { kind: 'noHandler' }                                 — 404 (or explicit appId not installed)
 *   { kind: 'setup-required', appId, state, error }       — 409: the start gate refuses the app
 *                                                           (`error` is its D105 body, D108 A2)
 * A malformed intent (unknown flag, bad instanceId, …) answers 4xx
 * `{ kind: 'error', code, error, hint? }`.
 *
 * OPEN_TERMINAL (D29, 5.16): `command` needs the System Terminal (its
 * instance token) or the owner (the desktop's own page, or the host operator);
 * from an app, `background` needs the owner's `terminal.embed` grant and
 * `sessionId` a session the app was granted (403 `terminal-not-granted`); a
 * caller that is no verified app needs the owner for all three. A session an
 * app creates with `background` is granted to it here.
 *
 * An app may not name a system app or a trusted system UI (D45) as the
 * target (`appId`, or `instanceId` of one) of its intent: 403
 * `target-not-allowed`. Implicit resolution, its own app, and OPEN_TERMINAL
 * to the System Terminal (held by the rules above) stay open.
 *
 * A VIEW of an App Host address goes to the app holding that App Host, not
 * to whatever handles http(s): Aura Browser opens other apps this way, as
 * their own Activity (lib/appHostIntent.ts). It then counts as naming that
 * app, so every check on an explicit target applies.
 */
export const POST: APIRoute = async (ctx) => {
  const { request } = ctx;
  const body = await request.json().catch(() => null) as IntentBody | null;
  if (!body || typeof body.action !== 'string' || body.action.length === 0) {
    return errorResponse('Intent body must include a string `action`', 400);
  }
  const intent: {
    action: string; appId?: string; category?: string[]; type?: string; uri?: string;
    extras?: Record<string, unknown>; instanceId?: string; flags?: string[];
  } = {
    action: body.action,
    ...(typeof body.appId === 'string' && body.appId.length > 0 ? { appId: body.appId } : {}),
    ...(Array.isArray(body.category) ? { category: body.category.filter((c): c is string => typeof c === 'string') } : {}),
    ...(typeof body.type === 'string' ? { type: body.type } : {}),
    ...(typeof body.uri  === 'string' ? { uri:  body.uri  } : {}),
    ...(body.extras && typeof body.extras === 'object' && !Array.isArray(body.extras) ? { extras: body.extras as Record<string, unknown> } : {}),
    ...(typeof body.instanceId === 'string' && body.instanceId.length > 0 ? { instanceId: body.instanceId } : {}),
    ...(Array.isArray(body.flags) ? { flags: body.flags.filter((f): f is string => typeof f === 'string') } : {}),
  };
  if (body.instanceId !== undefined && typeof body.instanceId !== 'string') {
    return errorResponse('`instanceId` must be a string', 400);
  }
  if (body.flags !== undefined && !Array.isArray(body.flags)) {
    return errorResponse('`flags` must be an array of strings', 400);
  }
  const appHostApp = await appHostViewTarget(intent);
  if (appHostApp) intent.appId = appHostApp;
  const caller = await verifiedAppCaller(request);
  if (caller === 'invalid') return errorResponse('The caller identity did not verify', 401);
  if (caller) {
    const blocked = explicitTargetRefusal(intent, caller, getAppManager());
    if (blocked) return jsonResponse({ kind: 'error', code: 'target-not-allowed', error: blocked }, 403);
  }
  const asking = caller ?? (openTerminalNeedsProof(intent) && await isOwnerCaller(ctx) ? { owner: true } : null);
  const refusal = await openTerminalRefusal(intent, asking);
  if (refusal) return jsonResponse({ kind: 'error', code: 'terminal-not-granted', error: refusal, message: refusal, ...terminalGrantFacts(intent, caller) }, 403);
  try {
    // The verified caller's user (D46): the handler's hook gets it.
    const userId = (await requestUserId(request)) ?? undefined;
    const result = await getAppManager().startIntent(intent, userId ? { userId } : {});
    if (result.kind === 'noHandler') return noHandler(intent);
    if (result.kind === 'rejected') return jsonResponse({ ...result, error: result.message }, result.status);
    // D108 A2: the app may not start (no setup engine yet, or a newer Aura contract): its D105 body.
    if (result.kind === 'setup-required') return jsonResponse(result, 409);
    // Only the System Terminal's own answer to OPEN_TERMINAL names a session it created.
    const created = (result as { result?: Record<string, unknown> }).result?.['sessionId'];
    if (caller && intent.action === OPEN_TERMINAL_ACTION && intent.extras?.['background'] === true
      && result.kind === 'started' && result.appId === TERMINAL_APP_ID && await isSystemTerminal(TERMINAL_APP_ID)
      && terminalSessionInstance(created) === result.instanceId && typeof created === 'string'
      && !(await isSystemTerminal(caller.appId))) {
      // Without it the app can't show the session it asked for; the session itself is fine.
      await grantSession(caller.appId, created).catch((err: unknown) => {
        console.warn(`[intents] could not grant ${created} to ${caller.appId}: ${(err as Error).message}`);
      });
    }
    return jsonResponse(result);
  } catch (err) {
    if (err instanceof IntentError) {
      return jsonResponse({ kind: 'error', code: err.code, error: err.message, ...(err.hint ? { hint: err.hint } : {}) }, err.status);
    }
    // A coded refusal (409 app-disabled, …) in the intent error shape: `code` the code, `error` the sentence.
    const coded = auraErrorOf(err);
    if (coded) {
      const { error: code, ...facts } = coded.body;
      return jsonResponse({ kind: 'error', code, error: facts.message, ...facts }, coded.status);
    }
    return failureResponse(ctx, err);
  }
};

/**
 * 404 when no installed app handles the intent (D105 Pass B, review row 23):
 * what was asked and where a handler declares it. `kind: 'noHandler'` stays
 * the answer the SDK reads.
 */
function noHandler(intent: { action: string; type?: string; appId?: string }): Response {
  const what = `'${intent.action}'${intent.type ? ` (${intent.type})` : ''}`;
  return jsonResponse({
    kind: 'noHandler', error: 'no-handler', category: 'not-found', manifestField: 'intents[]',
    message: intent.appId ? `${intent.appId} does not handle the intent ${what}, or it is not installed.` : `No installed app handles the intent ${what}.`,
    hint: 'An app handles an intent it declares in app.manifest.json intents[]; aura get apps -o wide lists the installed apps.',
  }, 404);
}


/**
 * What an app may do about a refused OPEN_TERMINAL (D105 Pass B, review row
 * 25). Only `background` is the app's to get: the owner's `terminal.embed`
 * grant. `command` and other sessions are nobody's to grant (no hint).
 */
function terminalGrantFacts(intent: { extras?: Record<string, unknown> }, caller: { appId: string } | null): Record<string, string> {
  const extras = intent.extras ?? {};
  if (!caller || Object.hasOwn(extras, 'command') || Object.hasOwn(extras, 'sessionId') || extras['background'] !== true) {
    return { category: 'not-grantable' };
  }
  return {
    category: 'missing-permission', permission: 'terminal.embed', holder: 'owner-grant', manifestField: 'permissions[]',
    hint: `Declare "terminal.embed" in permissions[]; the owner grants it: aura grant notif-perms ${caller.appId} terminal.embed.`,
  };
}
