/**
 * `OsError`: the one error type of the SDK. Every module throws it (or one of
 * its named subclasses, kept so existing `instanceof` checks still work):
 *
 *   try { await osClient.storage.set('k', v); }
 *   catch (err) {
 *     if (err instanceof OsError && err.status === 403) hideFeature();
 *     else throw err;
 *   }
 *
 * `status` is the HTTP status of the OS answer, 0 when there was none (no
 * network, a call made outside AuraOS, a bad argument). `code` is a short
 * closed identifier: the OS's `error` field, else `http-<status>`.
 *
 * Subclasses (all `instanceof OsError`): NotificationsError, OsSidecarError,
 * StorageError, UserError, UserConfirmError, IntentRejectedError.
 */
export class OsError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message?: string, opts: { details?: unknown } = {}) {
    super(message ?? `${code} (${status})`);
    this.name = 'OsError';
    this.status = status;
    this.code = code;
    if (opts.details !== undefined) this.details = opts.details;
  }
}

/** The code for a status without an `error` field. */
export const statusCode = (status: number): string => (status === 0 ? 'no-response' : `http-${status}`);

/**
 * An `OsError` from a failed OS answer: its JSON `error` becomes `code`, its
 * `message` (or the error) the message, prefixed with `what` (`storage`, …).
 * Reads the body; call it only for a response you won't read again.
 */
export async function osErrorFrom(res: Response, what: string): Promise<OsError> {
  const text = await res.text().catch(() => '');
  let body: { error?: unknown; message?: unknown; details?: unknown } | null = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* plain text */ }
  const code = typeof body?.error === 'string' ? body.error : statusCode(res.status);
  const detail = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : text.slice(0, 200);
  return new OsError(res.status, code, `${what} → ${res.status}${detail ? ` ${detail}` : ''}`,
    body?.details !== undefined ? { details: body.details } : {});
}
