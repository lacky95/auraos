import { shellUrl } from './shell-url.js';
import { APPROVAL_HEADER, askOwner, needsApprovalOf } from './approval.js';
import { shellFetch } from './identity.js';

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
      throw e;
    }
    res = await send(answer.approvalId);
    text = await res.text();
  }
  if (!res.ok) {
    const refusedHere = path.startsWith('/api/admin/') && (res.status === 401 || res.status === 403)
      && /"error"\s*:\s*"(access-denied|unauthenticated)"/.test(text);
    const e = new Error(refusedHere
      ? `${method} ${path} is the owner's (${res.status}). Run it in the System Terminal (the owner approves it in the desktop), `
        + 'use Settings, or run it on the host: docker exec -it aura-shell aura …'
      : `${method} ${path} failed with ${res.status}: ${text}`) as ShellError;
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
