// 127.0.0.1, not localhost: the CLI is most often invoked from inside a PRoot
// sandbox, and the bound base-rootfs has no /etc/hosts entry for `localhost`
// (Debian-slim ships an empty one). Using the literal address skips the DNS
// lookup that would otherwise fail with ENOTFOUND. On the host or in a normal
// container both resolve to the same loopback, so there's no downside.
const DEFAULT_SHELL_URL = 'http://127.0.0.1:3000';

export function shellUrl(): string {
  return process.env['AURA_SHELL_URL'] ?? DEFAULT_SHELL_URL;
}

export interface ShellError extends Error {
  status?: number;
  body?: string;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${shellUrl()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const e = new Error(
      `Cannot reach AuraOS shell at ${shellUrl()} — is the container running?\n  ${String(err)}`,
    ) as ShellError;
    throw e;
  }
  const text = await res.text();
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
  const url = `${shellUrl()}${path}`;

  void (async () => {
    try {
      const res = await fetch(url, {
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
