import { sourceClosedBody, type AuraErrorBody } from '@aura/core';
import { shellUrl } from './shell-url.js';
import { APPROVAL_HEADER, askOwner, needsApprovalOf } from './approval.js';
import { shellFetch } from './identity.js';

export { shellUrl };

export interface ShellError extends Error {
  status?: number;
  body?: string;
  /** The shell's error body, when it sent JSON (AuraOS's one error body: `error` is the code). */
  data?: ErrorBodyView;
  /** The process exit code for this failure (EXIT). */
  exitCode?: number;
}

/** What the CLI reads of an error body: the one error body's fields, all optional (older routes send fewer). */
export type ErrorBodyView = Partial<AuraErrorBody> & Record<string, unknown>;

/**
 * Exit codes of a failed command: 1 any error, 3 refused (401/403: not
 * signed in, or not allowed), 4 not found, 5 the owner's approval was not
 * given (denied, expired or not offered here).
 */
export const EXIT = { error: 1, refused: 3, notFound: 4, notApproved: 5 } as const;

export function exitCodeOf(err: unknown): number {
  const e = err as ShellError | null;
  if (typeof e?.exitCode === 'number') return e.exitCode;
  return statusExit(e?.status);
}

const statusExit = (status: number | undefined): number =>
  status === 401 || status === 403 ? EXIT.refused : status === 404 ? EXIT.notFound : EXIT.error;

/**
 * A local write the file system refused as read-only (EROFS) as the one
 * error body (D105 Pass B, review row 30): under /mnt/aura/<app> that is a
 * closed install's source, with the way out; elsewhere it says what is
 * read-only. Null for any other error.
 */
export function readOnlyError(err: unknown): ShellError | null {
  const e = err as NodeJS.ErrnoException | null;
  if (e?.code !== 'EROFS') return null;
  const appId = /\/mnt\/aura\/([a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+)(?:\/|$)/.exec(e.path ?? '')?.[1];
  const body: AuraErrorBody = appId ? sourceClosedBody(appId) : {
    error: 'read-only', category: 'not-grantable', message: `${e.path ?? 'This path'} is read-only here.`,
    hint: 'aura dev status <app> prints where an app is writable.',
  };
  const out = new Error(`${body.message}\n  Fix: ${body.hint}`) as ShellError;
  out.data = body as ErrorBodyView;
  out.exitCode = EXIT.error;
  return out;
}

/** `-o json`, `-ojson`, `--output json`, `--output=json` or `--json`: errors go out as JSON too. */
export function wantsJsonErrors(argv: readonly string[]): boolean {
  return argv.some((a, i) => a === '--json' || a === '-ojson' || a === '--output=json'
    || ((a === '-o' || a === '--output') && argv[i + 1] === 'json'));
}

/** A failure as one JSON object (for stderr): the shell's error body when it sent one, plus its status. */
export function errorJson(err: unknown): string {
  const e = err as ShellError | null;
  const message = e instanceof Error ? e.message : String(err);
  const base: Record<string, unknown> = e?.data ? { ...e.data } : { error: 'cli-error' };
  return JSON.stringify({
    ...base,
    message: typeof base['message'] === 'string' ? base['message'] : message,
    ...(e?.status ? { status: e.status } : {}),
  });
}

/** The JSON object of an error answer, or null (plain text, an array, nothing). */
export function errorBodyOf(text: string | undefined): ErrorBodyView | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as ErrorBodyView : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * The status line's labels: the status, the code and, when it adds
 * something, the reason (`403 access-denied · missing-permission`).
 */
function labels(status: number, body: ErrorBodyView): string {
  const code = str(body.error);
  const reason = str(body.reason);
  return [`${status}`, code && code.length <= 64 && !/\s/.test(code) ? code : undefined]
    .filter(Boolean).join(' ') + (reason && reason !== code ? ` · ${reason}` : '');
}

/**
 * A failed shell call, readable: what was refused, why, and the fix.
 *
 *   POST /api/instances/x/mounts: refused (403 access-denied · missing-target-permission)
 *     The app this call acts on has to hold 'apps.mount' for this call, and does not.
 *     Fix: The owner adds 'apps.mount' to that app: aura grant perms <that app> apps.mount.
 *
 * A body without a message (an older route) keeps the old form: the status
 * and the raw body.
 */
export function formatShellError(method: string, path: string, status: number, text: string, localHint?: string): string {
  const body = errorBodyOf(text);
  const message = body && (str(body.message) ?? (str(body.error)?.includes(' ') ? str(body.error) : undefined));
  if (!body || !message) {
    return `${method} ${path} failed with ${status}: ${text}${localHint ? `\n  ${localHint}` : ''}`;
  }
  const what = status === 401 || status === 403 ? 'refused' : 'failed';
  const hint = str(body.hint) ?? localHint;
  return [`${method} ${path}: ${what} (${labels(status, body)})`, `  ${message}`, ...(hint ? [`  Fix: ${hint}`] : [])].join('\n');
}

/**
 * The short form for a command that names the subject itself (mount, port,
 * clone): the message, its labels and the fix, without the method and path.
 */
export function shellErrorText(err: unknown): string {
  const e = err as ShellError;
  if (typeof e?.body !== 'string' || e.body.length === 0) return e instanceof Error ? e.message : String(err);
  const body = errorBodyOf(e.body);
  const message = body && (str(body.message) ?? str(body.error));
  if (!body || !message) return e.status ? `HTTP ${e.status}: ${e.body}` : e.body;
  const hint = str(body.hint);
  // A code-only body (`{error: 'not-found'}`) reads as before: `not-found (HTTP 404)`.
  const label = !e.status ? '' : message === str(body.error) ? ` (HTTP ${e.status})` : ` (HTTP ${labels(e.status, body)})`;
  return `${message}${label}${hint ? `\n  Fix: ${hint}` : ''}`;
}

function causeOf(err: unknown): string {
  const cause = (err as { cause?: { message?: string } }).cause?.message;
  return cause ? ` (${cause})` : '';
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const send = async (approvalId?: string): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (approvalId) headers[APPROVAL_HEADER] = approvalId;
    try {
      // Every call carries this process's identity (identity.ts).
      return await shellFetch(path, {
        method,
        headers,
        intent: 'self',
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const e = new Error(
        `Cannot reach AuraOS shell at ${shellUrl()} — is the container running?\n  ${String(err)}${causeOf(err)}`,
      ) as ShellError;
      throw e;
    }
  };
  let res = await send();
  let text = await res.text();
  // The owner decides this call (D50, 5.10): show what the server built, wait
  // for the desktop, then send the very same request with the approval.
  const asked = needsApprovalOf(res.status, text);
  if (asked) {
    const answer = await askOwner(asked);
    if ('refused' in answer) {
      const e = new Error(`${method} ${path}: ${answer.refused}`) as ShellError;
      e.status = res.status;
      e.body = text;
      e.data = { ...(errorBodyOf(text) ?? {}), error: 'not-approved', message: answer.refused };
      e.exitCode = EXIT.notApproved;
      throw e;
    }
    res = await send(answer.approvalId);
    text = await res.text();
  }
  if (!res.ok) {
    const body = errorBodyOf(text);
    // The owner's management routes: where this CLI can run them (the server never says it to an app).
    const ownersRoute = path.startsWith('/api/admin/') && (res.status === 401 || res.status === 403)
      && (body?.error === 'access-denied' || body?.error === 'unauthenticated');
    const e = new Error(formatShellError(method, path, res.status, text, ownersRoute
      ? 'This is the owner\'s: run it in the System Terminal (the owner approves it in the desktop), use Settings, '
        + 'or run it on the host: docker exec -it aura-shell aura …'
      : undefined)) as ShellError;
    e.status = res.status;
    e.body = text;
    if (body) e.data = body;
    e.exitCode = statusExit(res.status);
    throw e;
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export const api = {
  get:    <T>(path: string)               => request<T>('GET',    path),
  post:   <T>(path: string, body?: unknown) => request<T>('POST',   path, body),
  put:    <T>(path: string, body?: unknown) => request<T>('PUT',    path, body),
  del:    <T>(path: string)               => request<T>('DELETE', path),
};

export interface SseEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Subscribe to the shell's SSE event stream. Calls onEvent for each parsed
 * message. Returns an abort function that closes the stream.
 */
export function subscribeEvents(
  path: string,
  onEvent: (ev: SseEvent) => void,
  onError?: (err: Error) => void,
): () => void {
  const controller = new AbortController();

  void (async () => {
    try {
      // The stream carries this process's identity like any other call.
      const res = await shellFetch(path, {
        headers: { Accept: 'text/event-stream' },
        intent: 'self',
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        onError?.(new Error(`SSE ${path} failed: ${res.status}`));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (!payload) continue;
            try {
              onEvent(JSON.parse(payload) as SseEvent);
            } catch {
              // ignore malformed event lines
            }
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      onError?.(err as Error);
    }
  })();

  return () => controller.abort();
}
