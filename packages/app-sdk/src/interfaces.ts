/**
 * `osClient.interfaces` — look up who provides what, and publish what this app
 * provides.
 *
 * The OS is a phone book: it answers "who provides X, and what address do I
 * dial?" and then stays out of the way. Everything here returns an address you
 * then talk to **directly** — nothing an app sends to a provider passes
 * through the OS.
 *
 * Two ways an interface exists:
 *   • declared in the manifest (`provides`) — the OS registers it whenever an
 *     instance of the app is live, and it stays discoverable in the catalog
 *     even while the app is stopped;
 *   • opened at runtime via `register()` — for interfaces whose address isn't
 *     known until the app is up. Those are bound to the instance: the OS drops
 *     them when it stops, so forgetting `unregister()` cannot leak.
 */
import type { OsClient } from './OsClient.js';
import { getAppContext } from './context.js';

/** Transports the OS can describe today. */
export type InterfaceKind = 'http' | 'rest' | 'mcp' | 'ws' | 'event' | 'kv';

export interface InterfaceView {
  /** `<appId>/<name>` — globally unique. */
  id: string;
  appId: string;
  name: string;
  kind: InterfaceKind;
  version: string;
  address: string;
  description?: string;
  schema?: string;
  permission?: string;
  source: 'manifest' | 'runtime';
  /** `live` is dialable; `catalog` means installed but nothing running. */
  status: 'catalog' | 'live' | 'down';
  instanceId?: string;
  state?: string;
  /** Shell-relative; use `urlFor()` to get something fetchable from anywhere. */
  url?: string;
  upstream?: { host: string; port: number } | null;
}

export interface ConsumerView {
  appId: string;
  need: { name: string; kind: InterfaceKind; appId?: string; version?: string; required: boolean };
  status: 'live' | 'installed' | 'unmet';
  matches: string[];
}

export interface InterfaceFilter {
  kind?: InterfaceKind;
  appId?: string;
  name?: string;
  /** Only entries a running instance currently serves. */
  live?: boolean;
}

/** What an app publishes at runtime. `version` defaults to '1' server-side. */
export interface InterfaceSpec {
  name: string;
  kind: InterfaceKind;
  address: string;
  version?: string;
  description?: string;
  schema?: string;
  permission?: string;
}

export class InterfacesApi {
  constructor(_client: OsClient) {}

  /** Everything the OS knows about, optionally filtered. */
  async list(filter: InterfaceFilter = {}): Promise<InterfaceView[]> {
    const q = new URLSearchParams();
    if (filter.kind)  q.set('kind',  filter.kind);
    if (filter.appId) q.set('appId', filter.appId);
    if (filter.name)  q.set('name',  filter.name);
    if (filter.live)  q.set('live',  '1');
    q.set('consumers', '0');           // callers of list() never want the report
    const res = await fetch(`${this.base()}/api/interfaces?${q}`, { headers: this.identity() });
    if (!res.ok) return [];
    const body = await res.json() as { interfaces?: InterfaceView[] };
    return body.interfaces ?? [];
  }

  /** The resolution report — who needs what, and whether it is satisfied. */
  async consumers(): Promise<ConsumerView[]> {
    const res = await fetch(`${this.base()}/api/interfaces`, { headers: this.identity() });
    if (!res.ok) return [];
    const body = await res.json() as { consumers?: ConsumerView[] };
    return body.consumers ?? [];
  }

  /**
   * The single best provider for a ref, or null when nothing provides it.
   *
   * Accepts `'com.acme.api/transcribe'` or an object. A stopped-but-installed
   * provider is returned with `status: 'catalog'` rather than null, so a caller
   * can tell "not installed" from "not running" — they need different fixes.
   */
  async resolve(ref: string | { appId?: string; name: string; kind?: InterfaceKind }): Promise<InterfaceView | null> {
    const want = typeof ref === 'string' ? parseRef(ref) : ref;
    const candidates = await this.list({
      ...(want.appId ? { appId: want.appId } : {}),
      name: want.name,
      ...(want.kind ? { kind: want.kind } : {}),
    });
    // Same ranking the OS uses: live beats down beats catalog.
    const rank = (v: InterfaceView) => (v.status === 'live' ? 0 : v.status === 'down' ? 1 : 2);
    return [...candidates].sort((a, b) => rank(a) - rank(b))[0] ?? null;
  }

  /**
   * A fetchable URL for a resolved interface. `view.url` is shell-relative,
   * which is already correct in a browser (the app iframe is same-origin) but
   * not from the app's server, where the OS base has to be prefixed.
   * Returns null when the interface isn't live.
   */
  urlFor(view: InterfaceView): string | null {
    if (!view.url) return null;
    return `${this.base()}${view.url}`;
  }

  /** Publish an interface this instance just opened. */
  async register(spec: InterfaceSpec): Promise<InterfaceView | null> {
    const res = await fetch(`${this.base()}/api/interfaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.identity() },
      body: JSON.stringify(spec),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(`interfaces.register('${spec.name}') failed: ${body.error ?? res.status}`);
    }
    const body = await res.json() as { interface?: InterfaceView };
    return body.interface ?? null;
  }

  /**
   * Withdraw a runtime registration. Best-effort by design — the OS drops
   * every one of this instance's interfaces when it stops, so an app that
   * never calls this still cannot leak one.
   */
  async unregister(name: string): Promise<boolean> {
    const res = await fetch(`${this.base()}/api/interfaces/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: this.identity(),
    });
    if (!res.ok) return false;
    const body = await res.json() as { removed?: boolean };
    return body.removed === true;
  }

  // ---- Internals ----

  /**
   * Browser: '' — the iframe is served through the shell's proxy, so relative
   * URLs already hit the OS. Node: OS_API_BASE. Same split as ActivityApi.
   */
  private base(): string {
    if (typeof window !== 'undefined') return '';
    return process.env['OS_API_BASE'] ?? 'http://localhost:3000';
  }

  /**
   * Server-side callers have no Referer, so they say who they are with the id
   * the OS injected at spawn. Harmless in the browser (the OS prefers the
   * Referer there, which an app cannot forge).
   */
  private identity(): Record<string, string> {
    if (typeof window !== 'undefined') return {};
    const ctx = getAppContext();
    return { 'X-Aura-App-Id': ctx.appId, 'X-Aura-Instance-Id': ctx.instanceId };
  }
}

/** `com.acme.api/transcribe` → { appId, name }; a bare name has no appId. */
function parseRef(ref: string): { appId?: string; name: string; kind?: InterfaceKind } {
  const slash = ref.lastIndexOf('/');
  if (slash <= 0) return { name: ref };
  return { appId: ref.slice(0, slash), name: ref.slice(slash + 1) };
}
