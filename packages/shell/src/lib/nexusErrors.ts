import { auraErrorOf } from '@aura/core';
import type { AuraErrorBody } from '@aura/core';
import { failureBody, errorResponse, errorAudience, legacyErrorBody, type ErrorAudience } from './appResponse.js';

/**
 * Nexus install, update, publish and uninstall failures as answers (D105
 * Pass B, review row 29): the status and code a client can act on instead of
 * a 500 with the sentence. Matched by name and shape, not `instanceof` (two
 * copies of core). Anything not recognised is a failure for its reader
 * (`failureBody`: redacted unless the owner reads it).
 */
export function nexusFailureBody(err: unknown, audience: ErrorAudience): { status: number; body: AuraErrorBody } {
  const carried = auraErrorOf(err);
  if (carried) return carried;
  const e = err as { name?: unknown; issues?: unknown; host?: unknown; reason?: unknown; code?: unknown; appId?: unknown } | null;
  if (e?.name === 'NexusValidationError' && Array.isArray(e.issues)) {
    const issues = e.issues.filter((i): i is string => typeof i === 'string');
    const field = /^([\w.[\]-]+): /.exec(issues[0] ?? '')?.[1];
    return {
      status: 422,
      body: {
        error: 'manifest-invalid', category: 'invalid-input',
        message: `The app's manifest is not valid: ${issues[0] ?? 'see details'}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''}.`,
        ...(field && field !== '<root>' ? { manifestField: field } : {}),
        hint: 'aura dev validate shows every issue with its manifest field.',
        details: { issues },
      },
    };
  }
  if (e?.name === 'OrasAuthError' && typeof e.host === 'string') {
    const forbidden = e.reason === 'forbidden';
    return {
      status: 403,
      body: {
        error: forbidden ? 'registry-forbidden' : 'registry-login', category: forbidden ? 'permission-denied' : 'not-authenticated',
        message: audience === 'owner' ? String((err as Error).message) : forbidden ? `${e.host} refused this for that login.` : `${e.host} needs a valid login.`,
        hint: forbidden
          ? `Give that source's login the right to do this, then set it: aura nexus registry login <source> (or Nexus → Sources).`
          : 'Set the source\'s login: aura nexus registry login <source> (or Nexus → Sources → Edit login).',
      },
    };
  }
  if (e?.code === 'system-app' && typeof e.appId === 'string') {
    return {
      status: 409,
      body: {
        error: 'system-app', category: 'not-grantable', target: e.appId,
        message: `${e.appId} is a built-in system app: it cannot be deleted, and its data stays.`,
        hint: `Disable it instead: aura disable app ${e.appId}.`,
      },
    };
  }
  return failureBody(err, audience);
}

/**
 * The answer to a Nexus failure, for this request's reader. The Nexus app
 * still shows `error`, so the body is the migration form (`legacyErrorBody`):
 * the right status and every fact, `error` the sentence.
 */
export async function nexusFailure(ctx: { request: Request; locals?: App.Locals }, err: unknown): Promise<Response> {
  const { status, body } = nexusFailureBody(err, auraErrorOf(err) ? 'app' : await errorAudience(ctx));
  return errorResponse(status, legacyErrorBody(body));
}
