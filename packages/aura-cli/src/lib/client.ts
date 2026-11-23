import { shellUrl } from './shell-url.js';
import { isAdminPath, recoverAdminSession } from './admin-session.js';
import { adminRefusal, isTrustedShellUrl, shellFetch } from './identity.js';

export { shellUrl };

export interface ShellError extends Error {
  status?: number;
  body?: string;
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
  const admin = isAdminPath(path);
  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      // /api/admin/* takes the admin session. Everything else stays anonymous (see identity.ts).
      return await shellFetch(path, {
        method,
        headers,
        intent: admin ? 'admin' : 'anonymous',
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
  // An admin route refused us: get a session (env / master key file / prompt)
  // and retry once. Without one, explain how instead of a bare 401.
  if (admin && res.status === 401 && /"error"\s*:\s*"admin-(required|session-invalid)"/.test(text)) {
    if (await recoverAdminSession()) {
      res = await send();
      text = await res.text();
    }
    if (res.status === 401) {
      const e = new Error(
        `${method} ${path} needs an admin session.\n` +
        (isTrustedShellUrl(shellUrl())
          ? '  Run `aura admin login --save` (asks for the shared admin credential), or set AURA_ADMIN_CREDENTIAL / AURA_ADMIN_SESSION.\n' +
            '  Read the credential on the host: `docker exec -it aura-shell aura admin credential`.'
          : `  ${adminRefusal(shellUrl())}`),
      ) as ShellError;
      e.status = 401;
      e.body = text;
      throw e;
    }
  }
  if (!res.ok) {
    const e = new Error(`${method} ${path} failed with ${res.status}: ${text}`) as ShellError;
    e.status = res.status;
    e.body = text;
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
      const res = await shellFetch(path, {
        headers: { Accept: 'text/event-stream' },
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
