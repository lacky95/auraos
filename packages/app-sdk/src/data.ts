/**
 * `osClient.data`: other apps' content providers (Android ContentResolver).
 *
 *   const theme = await osClient.data.query('com.aura.settings', 'theme');
 *   await osClient.data.write('com.example.notes', 'notes/1', { text });
 *   const es = osClient.data.watch('com.example.notes', 'notes');   // a page: SSE
 *
 * `resource` is the path SEGMENT after `/api/data/<authority>/` (for a
 * provider declared as `/api/data/theme`, pass `"theme"`). From a page the
 * call goes through the App Host gateway; on a server it sends the instance
 * token. Reading needs the provider entry's `readPermission`, writing its
 * `writePermission` (unless the app is the provider). The flat
 * `queryProvider` / `writeProvider` / `watchProvider` are deprecated aliases.
 */
import { OsError, statusCode } from './errors.js';
import { osAuthHeaders } from './os-auth.js';

export class DataApi {
  constructor(private readonly base: () => string) {}

  private url(authority: string, resource: string, query = ''): { url: string; label: string } {
    const r = resource.replace(/^\/+/, '');
    return { url: `${this.base()}/api/data/${encodeURIComponent(authority)}/${r}${query ? `${r.includes('?') ? '&' : '?'}${query}` : ''}`, label: `${authority}/${r}` };
  }

  async query<T = unknown>(authority: string, resource: string): Promise<T> {
    const { url, label } = this.url(authority, resource);
    const res = await fetch(url, { headers: osAuthHeaders(url) });
    if (!res.ok) throw new OsError(res.status, statusCode(res.status), `queryProvider ${label} → HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** Method defaults to PUT; pass POST/PATCH/DELETE to override. Body is JSON-encoded. */
  async write<T = unknown>(
    authority: string, resource: string, body: unknown, method: 'PUT' | 'POST' | 'PATCH' | 'DELETE' = 'PUT',
  ): Promise<T> {
    const { url, label } = this.url(authority, resource);
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...osAuthHeaders(url) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new OsError(res.status, statusCode(res.status), `writeProvider ${label} → HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /**
   * An SSE stream of the provider with `?watch=1` appended (the provider
   * implements its own watch handler). Browser `EventSource`: pages only.
   */
  watch(authority: string, resource: string): EventSource {
    return new EventSource(this.url(authority, resource, 'watch=1').url);
  }
}
