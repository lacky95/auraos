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
  /**
   * The structured facts of a refusal, when the OS sent them (AuraOS's one
   * error body): `reason` (the access reason, e.g. `missing-permission`),
   * `category` (what you may do about it: `missing-declaration`,
   * `missing-permission`, `needs-approval`, `not-grantable`, …), the fix in
   * `hint`, `docs`, the missing `permission`, who must hold it (`holder`:
   * `caller`, `target`, `owner-grant`), the `manifestField`, the `target` you
   * named, a security option (`policy`) or a `capability`. Each is absent
   * when it does not apply.
   */
  readonly reason?: string;
  readonly category?: string;
  readonly hint?: string;
  readonly docs?: string;
  readonly permission?: string;
  readonly holder?: string;
  readonly manifestField?: string;
  readonly target?: string;
  readonly policy?: string;
  readonly capability?: string;
  constructor(status: number, code: string, message?: string, opts: { details?: unknown; facts?: OsErrorFacts } = {}) {
    super(message ?? `${code} (${status})`);
    this.name = 'OsError';
    this.status = status;
    this.code = code;
    if (opts.details !== undefined) this.details = opts.details;
    for (const k of FACT_KEYS) {
      const v = opts.facts?.[k];
      if (typeof v === 'string' && v) (this as Record<string, unknown>)[k] = v;
    }
  }
}

const FACT_KEYS = ['reason', 'category', 'hint', 'docs', 'permission', 'holder', 'manifestField', 'target', 'policy', 'capability'] as const;
export type OsErrorFacts = Partial<Record<typeof FACT_KEYS[number], string>>;

/** The code for a status without an `error` field. */
export const statusCode = (status: number): string => (status === 0 ? 'no-response' : `http-${status}`);

/**
 * An `OsError` from a failed OS answer: its JSON `error` becomes `code`, its
 * `message` (or the error) the message, prefixed with `what` (`storage`, …)
 * and followed by the `hint` when there is one; the structured facts
 * (`reason`, `hint`, `permission`, …) become fields. Reads the body; call it
 * only for a response you won't read again.
 */
export async function osErrorFrom(res: Response, what: string): Promise<OsError> {
  const text = await res.text().catch(() => '');
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = text ? JSON.parse(text) : null;
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { /* plain text */ }
  const code = typeof body?.['error'] === 'string' ? body['error'] as string : statusCode(res.status);
  const detail = typeof body?.['message'] === 'string' ? body['message'] as string
    : typeof body?.['error'] === 'string' ? body['error'] as string : text.slice(0, 200);
  const facts: OsErrorFacts = {};
  for (const k of FACT_KEYS) if (typeof body?.[k] === 'string') facts[k] = body[k] as string;
  const hint = facts.hint ? ` — ${facts.hint}` : '';
  return new OsError(res.status, code, `${what} → ${res.status}${detail ? ` ${detail}` : ''}${hint}`, {
    ...(body?.['details'] !== undefined ? { details: body['details'] } : {}), facts,
  });
}
