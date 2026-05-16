// Final fallback when no env var hints at the shell location. 127.0.0.1, not
// localhost: when invoked from a PRoot sandbox the bound base-rootfs has no
// /etc/hosts entry for `localhost` (Debian-slim ships an empty one), so the
// DNS lookup fails with ENOTFOUND. The literal address always resolves.
const DEFAULT_SHELL_URL = 'http://127.0.0.1:3000';

/**
 * Resolve the shell URL. Probe order:
 *   1. AURA_SHELL_URL — explicit override (set by `aura` shim, dev scripts).
 *   2. OS_API_BASE    — every app sandbox already exports this. PRoot apps
 *                        get `http://127.0.0.1:3000`; container-sandbox
 *                        apps get `http://aura-shell:3000` (the aura-net
 *                        hostname). Reading it here means `aura jump` from
 *                        inside a sibling container hits the right host
 *                        without any compose-level changes.
 *   3. Loopback default — last-ditch for direct host invocations.
 */
export function shellUrl(): string {
  return process.env['AURA_SHELL_URL']
      ?? process.env['OS_API_BASE']
      ?? DEFAULT_SHELL_URL;
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
