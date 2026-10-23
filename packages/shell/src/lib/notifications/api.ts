/**
 * NotificationApiClient — plain `fetch` wrappers for the shell's
 * `/api/notifications` routes (phase 1 + 2, `interact` from phase 3).
 *
 * DOM-free: no `document`, no `window` beyond an injectable `fetch`, so the
 * same client serves the shell DOM UI today and React / voice / AR
 * surfaces later.
 *
 * Phase 5: every request carries the tab's shell client session
 * (`X-Aura-Client-Session`, from the injected `headers()`); the server
 * answers in the view of that session's lock state (locked → public
 * without components, private redacted, secret left out) and refuses
 * changes while locked (403 "unlock first"). Without a session the server
 * returns nothing. The session is not a credential. Errors come back as
 * `NotificationApiError` with the HTTP status — callers treat 401/403 as
 * "not allowed" (`isAuthError`) instead of crashing.
 */
import type {
  Interaction, InteractionValue, Notification, NotificationPriority,
} from '@aura/core';

export type { Interaction, InteractionValue, Notification };

export interface ListParams {
  state?: 'active' | 'resolved' | 'removed' | 'all';
  sender?: string;
  priority?: NotificationPriority;
  limit?: number;
  cursor?: string;
}

export interface ListPage {
  items: Notification[];
  nextCursor?: string;
}

export interface ClearFilter {
  sender?: string;
  priority?: NotificationPriority;
}

export interface InteractPayload {
  componentId: string;
  value?: InteractionValue;
  values?: Record<string, InteractionValue>;
}

/** The answer the shell sends on a resolve button. */
export interface ButtonAnswer {
  buttonId: string;
  values: Record<string, InteractionValue>;
}

export class NotificationApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'NotificationApiError';
  }
  /** 401 / 403 — the caller may not do this (phase 2 auth). */
  get isAuthError(): boolean { return this.status === 401 || this.status === 403; }
  /** 404 / 409 — gone or no longer active; the store drops / refetches it. */
  get isGone(): boolean { return this.status === 404 || this.status === 409; }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface NotificationApiOptions {
  /** Base URL of the shell API. Default: '' (same origin). */
  base?: string;
  fetch?: FetchLike;
  /** Extra headers per request (phase 5: the client session). */
  headers?: () => Record<string, string>;
}

export class NotificationApiClient {
  private readonly base: string;
  private readonly doFetch: FetchLike;
  private readonly extraHeaders: () => Record<string, string>;

  constructor(opts: NotificationApiOptions = {}) {
    this.base = (opts.base ?? '').replace(/\/+$/, '');
    this.extraHeaders = opts.headers ?? (() => ({}));
    const f = opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new Error('NotificationApiClient: no fetch available');
    this.doFetch = (input, init) => f(input, init);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      let extra: Record<string, string> = {};
      try { extra = this.extraHeaders(); } catch { /* no session yet */ }
      res = await this.doFetch(`${this.base}/api/notifications${path}`, {
        method,
        headers: { ...extra, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
      });
    } catch (err) {
      throw new NotificationApiError(0, `network error: ${(err as Error)?.message ?? String(err)}`);
    }
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!res.ok) {
      const obj = (data && typeof data === 'object') ? data as Record<string, unknown> : {};
      const msg = typeof obj['error'] === 'string' ? obj['error']
        : typeof obj['message'] === 'string' ? obj['message']
        : `HTTP ${res.status}`;
      throw new NotificationApiError(res.status, msg, obj['details']);
    }
    return data as T;
  }

  private static enc(id: string): string { return encodeURIComponent(id); }

  list(params: ListParams = {}): Promise<ListPage> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
    const qs = q.toString();
    return this.call<ListPage>('GET', qs ? `?${qs}` : '');
  }

  /** Every page of a list query (bounded by `maxItems`). */
  async listAll(params: Omit<ListParams, 'cursor'> = {}, maxItems = 500): Promise<Notification[]> {
    const out: Notification[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.list({ limit: 200, ...params, ...(cursor ? { cursor } : {}) });
      out.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor && out.length < maxItems);
    return out.slice(0, maxItems);
  }

  /** One notification, or null when it no longer exists (404). */
  async get(id: string): Promise<Notification | null> {
    try {
      return await this.call<Notification>('GET', `/${NotificationApiClient.enc(id)}`);
    } catch (err) {
      if (err instanceof NotificationApiError && err.status === 404) return null;
      throw err;
    }
  }

  markDisplayed(id: string): Promise<Notification> {
    return this.call('POST', `/${NotificationApiClient.enc(id)}/displayed`);
  }

  markSeen(id: string): Promise<Notification> {
    return this.call('POST', `/${NotificationApiClient.enc(id)}/seen`);
  }

  /** User dismiss (409 for locked — use forceRemove). */
  dismiss(id: string): Promise<Notification> {
    return this.call('DELETE', `/${NotificationApiClient.enc(id)}`);
  }

  resolve(id: string, answer?: unknown): Promise<Notification> {
    return this.call('POST', `/${NotificationApiClient.enc(id)}/resolve`, answer === undefined ? {} : { answer });
  }

  /** A component interaction that keeps the notification active (phase 3). */
  interact(id: string, payload: InteractPayload): Promise<Notification> {
    return this.call('POST', `/${NotificationApiClient.enc(id)}/interact`, payload);
  }

  forceRemove(id: string): Promise<Notification> {
    return this.call('POST', `/${NotificationApiClient.enc(id)}/force-remove`);
  }

  /** Phase 6: an app desktop modal stops blocking (stays a normal dialogue; reason force-hidden). */
  forceHide(id: string): Promise<Notification> {
    return this.call('POST', `/${NotificationApiClient.enc(id)}/force-hide`);
  }

  /** Phase 5: delete ended (resolved / removed) items and their history now, optionally of one sender. */
  clearHistory(sender?: string): Promise<{ deleted: number }> {
    return this.call('DELETE', `/history${sender ? `?sender=${encodeURIComponent(sender)}` : ''}`);
  }

  /** Clear all active notifications matching the filter; locked ones are skipped. */
  clear(filter: ClearFilter = {}): Promise<{ cleared: number; skippedLocked: number }> {
    const q = new URLSearchParams();
    if (filter.sender) q.set('sender', filter.sender);
    if (filter.priority) q.set('priority', filter.priority);
    const qs = q.toString();
    return this.call('DELETE', qs ? `?${qs}` : '');
  }
}
