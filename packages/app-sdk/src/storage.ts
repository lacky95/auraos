/**
 * `osClient.storage`: small JSON values your app keeps in AuraOS (D46).
 *
 *   await osClient.storage.set('draft', { text });            // this user's
 *   const draft = await osClient.storage.get<{ text: string }>('draft');
 *   await osClient.storage.shared.set('board', columns);      // every user's
 *
 * Per user by default: each user of the app has their own values, and the
 * user is the one AuraOS verified for the call (the page's sign-in, or the
 * user your instance runs for), never one your app names. `shared` is the
 * same API over one area all users of the app see: use it only for data
 * that really is common.
 *
 * Needs `storage.read` and `storage.write` in app.manifest.json. Values are
 * JSON, keys are `[A-Za-z0-9._/-]`, up to 128 characters. Data your app
 * stored before AuraOS had users is read as the owner's.
 */
import { isBrowser, osAuthHeaders, osBase } from './os-auth.js';
import { OsError } from './errors.js';
import { ownAppId } from './context.js';

/** A failed storage call. An `OsError`. */
export class StorageError extends OsError {
  constructor(status: number, code: string) {
    super(status, code, `storage: ${code} (${status})`);
    this.name = 'StorageError';
  }
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,127}$/;

export class StorageApi {
  /** The app's storage for all its users. Absent on `shared` itself. */
  readonly shared: StorageApi | undefined;

  constructor(private readonly area: 'user' | 'shared' = 'user', private readonly appIdOverride?: string) {
    this.shared = area === 'user' ? new StorageApi('shared', appIdOverride) : undefined;
  }

  private appId(): string {
    const id = this.appIdOverride ?? ownAppId();
    if (!id) throw new StorageError(0, 'no-app-id');
    return id;
  }

  private url(key: string): string {
    if (!KEY.test(key) || key.includes(':')) throw new StorageError(0, 'invalid-key');
    const path = key.split('/').map(encodeURIComponent).join('/');
    const base = osBase({ mode: isBrowser() ? 'relative' : 'server' });
    return `${base}/api/kv/app/${encodeURIComponent(this.appId())}/${path}${this.area === 'shared' ? '?shared=1' : ''}`;
  }

  private async call(key: string, init: RequestInit = {}): Promise<Response> {
    const url = this.url(key);
    return fetch(url, { ...init, headers: { accept: 'application/json', ...(init.headers ?? {}), ...osAuthHeaders(url) } });
  }

  private static async fail(res: Response): Promise<never> {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new StorageError(res.status, typeof body.error === 'string' ? body.error : `http-${res.status}`);
  }

  /** The value, or null when there is none. */
  async get<T = unknown>(key: string): Promise<T | null> {
    const res = await this.call(key);
    if (res.status === 404) return null;
    if (!res.ok) return StorageApi.fail(res);
    return ((await res.json()) as { value: T }).value;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    const res = await this.call(key, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }),
    });
    if (!res.ok) await StorageApi.fail(res);
  }

  /** True when a value was removed. */
  async delete(key: string): Promise<boolean> {
    const res = await this.call(key, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) return StorageApi.fail(res);
    return ((await res.json()) as { removed?: boolean }).removed === true;
  }
}
