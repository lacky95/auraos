/**
 * Server-side fetch helper. Calls the AuraOS shell directly (no proxy hop)
 * using the `OS_API_BASE` env the runner injects. Falls back to localhost for
 * outside-OS dev runs.
 *
 * Copied from apps/com.aura.nexus/src/lib/shellClient.ts — apps don't share
 * code with each other (each is its own npm package), so the four-line helper
 * is duplicated rather than turned into an SDK export.
 */
const OS_API = process.env['OS_API_BASE'] ?? 'http://127.0.0.1:3000';

export async function shellGet<T>(path: string, timeoutMs = 8_000): Promise<T> {
  const res = await fetch(`${OS_API}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function shellPost<T>(path: string, body?: unknown, timeoutMs = 180_000): Promise<T> {
  const res = await fetch(`${OS_API}${path}`, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body:    body !== undefined ? JSON.stringify(body) : undefined,
    signal:  AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let err: string;
    try {
      const j = await res.json() as { error?: string; message?: string };
      err = j.message ?? j.error ?? res.statusText;
    } catch { err = res.statusText; }
    throw new Error(`${path} → HTTP ${res.status}: ${err}`);
  }
  return res.json() as Promise<T>;
}

export async function shellPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${OS_API}${path}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}
