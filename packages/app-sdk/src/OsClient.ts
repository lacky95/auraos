/**
 * Client used by apps to talk to the OS and other apps.
 *
 * Most cross-app data access goes through `queryProvider/writeProvider/watchProvider`,
 * which under the hood hit `/api/data/<authority>/<resource>` on the shell. The shell
 * proxy reads `Referer` for source-app identification, so calls made from an app's
 * iframe automatically carry their identity.
 */

export interface OsTheme {
  id: string;
  name: string;
  vars: Record<string, string>;
}

export class OsClient {
  private base: string;

  constructor() {
    this.base = process.env['OS_API_BASE'] ?? 'http://localhost:3000';
  }

  // -------- Notifications + lifecycle --------

  async sendNotification(title: string, body = ''): Promise<void> {
    const appId = process.env['APP_ID'] ?? 'unknown';
    await fetch(`${this.base}/api/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, title, body }),
    });
  }

  /** Returns this instance's lifecycle state via the OS status endpoint. */
  async getState(): Promise<string> {
    const instanceId = process.env['APP_INSTANCE_ID'] ?? process.env['APP_ID'] ?? 'unknown';
    const res = await fetch(`${this.base}/api/instances/${encodeURIComponent(instanceId)}/status`);
    const data = await res.json() as { instance: { state: string } };
    return data.instance.state;
  }

  // -------- Content-Provider Access --------

  /**
   * Read from another app's content provider.
   *
   * `resource` is the path SEGMENT after `/api/data/<authority>/` — e.g. for
   * Settings's theme endpoint declared as `/api/data/theme` in its manifest,
   * pass `"theme"` here. Don't include the `/api/data/` prefix.
   */
  async queryProvider<T = unknown>(authority: string, resource: string): Promise<T> {
    const r = resource.replace(/^\/+/, '');
    const url = `${this.base}/api/data/${encodeURIComponent(authority)}/${r}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`queryProvider ${authority}/${r} → HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /**
   * Write to another app's content provider. Method defaults to PUT; pass POST/PATCH/DELETE
   * to override. Body is JSON-encoded. `resource` is the short segment (see queryProvider).
   */
  async writeProvider<T = unknown>(
    authority: string,
    resource: string,
    body: unknown,
    method: 'PUT' | 'POST' | 'PATCH' | 'DELETE' = 'PUT',
  ): Promise<T> {
    const r = resource.replace(/^\/+/, '');
    const url = `${this.base}/api/data/${encodeURIComponent(authority)}/${r}`;
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`writeProvider ${authority}/${r} → HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /**
   * Open an SSE stream against a provider with `?watch=1` appended. The provider must
   * implement its own watch handler; the proxy just streams the response.
   */
  watchProvider(authority: string, resource: string): EventSource {
    const r = resource.replace(/^\/+/, '');
    const sep = r.includes('?') ? '&' : '?';
    const url = `${this.base}/api/data/${encodeURIComponent(authority)}/${r}${sep}watch=1`;
    return new EventSource(url);
  }

  // -------- Theme Convenience --------

  /** Returns the active OS theme (id + name + CSS vars). */
  async getOsTheme(): Promise<OsTheme> {
    const res = await this.queryProvider<{ themeId: string; theme: OsTheme }>(
      'com.aura.settings', 'theme',
    );
    return res.theme;
  }

  /**
   * Change the active OS theme. Settings persists + broadcasts; the shell and
   * iframes will re-render via SSE/postMessage.
   */
  async setOsTheme(themeId: string): Promise<void> {
    await this.writeProvider('com.aura.settings', 'theme', { themeId });
  }

  /**
   * Subscribe to theme changes broadcast from the shell via `postMessage`.
   * Returns an unsubscribe function. Browser-only — no-op on the server.
   */
  onThemeChange(cb: (info: { themeId: string }) => void): () => void {
    if (typeof window === 'undefined') return () => undefined;
    const handler = (ev: MessageEvent) => {
      const data = ev.data as { type?: string; themeId?: string };
      if (data?.type === 'aura.theme.changed' && data.themeId) {
        cb({ themeId: data.themeId });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }
}
