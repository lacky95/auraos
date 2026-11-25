/**
 * Server-side reads of the shell from a page's render. They carry this
 * instance's token, and on a page request from the signed-in owner the
 * router's owner SSR claim (D45, the SDK's `osAuthHeaders`), so they read as
 * the owner acting through Settings. The claim goes only to the shell.
 */
import { osAuthHeaders, osBase } from '@aura/app-sdk/os-auth';

const OS_API = osBase({ fallback: 'http://127.0.0.1:3000' });

export function shellFetch(request: Request, path: `/${string}`, timeoutMs: number): Promise<Response> {
  const url = `${OS_API}${path}`;
  return fetch(url, { headers: osAuthHeaders(url, { request }), signal: AbortSignal.timeout(timeoutMs) });
}
