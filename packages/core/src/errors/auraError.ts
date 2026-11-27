/**
 * The error that carries its D105 body (error-messages review Pass B), and
 * the shared texts every layer answers the same way. Foundation: imports
 * nothing at runtime.
 *
 * A domain module throws `new AuraError(status, body)` where it knows the
 * code, the facts and the fix; a boundary (a shell route, the CLI) answers
 * the body as is. Boundaries match by shape (`auraErrorOf`), not by
 * `instanceof`: an error from another copy of core (the Astro bundle and the
 * Node `dist`), or one of the older domain errors that already carries
 * `status` and `body` (B12 `SidecarIdentityError`), matches too.
 */
import type { AuraErrorBody } from './contracts.js';

export class AuraError extends Error {
  override readonly name = 'AuraError';
  /** The body's `error`: the closed code clients branch on. */
  readonly code: string;
  constructor(readonly status: number, readonly body: AuraErrorBody) {
    super(body.message);
    this.code = body.error;
  }
}

/** The status and D105 body an error carries, or null (matched by shape). */
export function auraErrorOf(err: unknown): { status: number; body: AuraErrorBody } | null {
  const e = err as { status?: unknown; body?: Partial<AuraErrorBody> } | null;
  if (!e || typeof e !== 'object' || typeof e.status !== 'number' || e.status < 400 || e.status > 599) return null;
  const b = e.body;
  return b && typeof b.error === 'string' && typeof b.message === 'string' ? { status: e.status, body: b as AuraErrorBody } : null;
}

/**
 * A closed install's source is read-only (Track P): the one text for every
 * place that meets it, the checkout route and a write that failed with
 * EROFS. `appId` is the caller's own subject (the app it named or works on).
 */
export function sourceClosedBody(appId: string): AuraErrorBody {
  return {
    error: 'source-closed',
    category: 'not-grantable',
    target: appId,
    message: `${appId} is a closed install: its source is read-only.`,
    hint: `Patch it (aura dev patch start ${appId}), or the owner opens it (aura dev open ${appId}).`,
  };
}
