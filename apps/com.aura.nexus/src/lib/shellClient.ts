/** Server-side fetch helper. Calls the shell directly (no proxy hop)
 *  using the OS_API_BASE env the runner injects. Falls back to localhost
 *  for outside-OS dev runs. A page's reads pass the page request: they carry
 *  this instance's token and, on the signed-in owner's page request, the
 *  router's owner SSR claim (D45, the SDK's `osAuthHeaders`), so they read as
 *  the owner acting through Nexus. */
import { osAuthHeaders, osBase } from '@aura/app-sdk/os-auth';

const OS_API = osBase({ fallback: 'http://127.0.0.1:3000' });

export async function shellGet<T>(request: Request, path: string, timeoutMs = 8_000): Promise<T> {
  const url = `${OS_API}${path}`;
  const res = await fetch(url, {
    headers: osAuthHeaders(url, { request }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function shellPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${OS_API}${path}`, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body:    body !== undefined ? JSON.stringify(body) : undefined,
    signal:  AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    let err: string;
    try { err = (await res.json() as { error?: string }).error ?? res.statusText; }
    catch { err = res.statusText; }
    throw new Error(`${path} → HTTP ${res.status}: ${err}`);
  }
  return res.json() as Promise<T>;
}
