/**
 * User actions on notifications — DOM-free. Wraps the API client, applies
 * every server response to the store right away (so the UI does not wait
 * for the bus event), and never throws: each call resolves to
 * `{ok:true, notification?}` or `{ok:false, error}` with a readable
 * message (401/403 included).
 */
import {
  NotificationApiError,
  type ButtonAnswer, type InteractPayload, type Notification, type NotificationApiClient,
} from './api.ts';
import type { NotificationClientStore } from './store.ts';

export type ActionResult =
  | { ok: true; notification?: Notification }
  /** `details`: the server's validation details (e.g. zod issues), when it sent any. */
  | { ok: false; status: number; error: string; details?: unknown };

type Api = Pick<NotificationApiClient,
  'markDisplayed' | 'markSeen' | 'dismiss' | 'resolve' | 'interact' | 'forceRemove' | 'forceHide' | 'clear' | 'clearHistory'>;
type Store = Pick<NotificationClientStore, 'apply' | 'drop' | 'get' | 'refetch'>;

function fail(err: unknown): ActionResult {
  if (err instanceof NotificationApiError) {
    const prefix = err.isAuthError ? 'Not allowed: ' : '';
    return { ok: false, status: err.status, error: `${prefix}${err.message}`, ...(err.details !== undefined ? { details: err.details } : {}) };
  }
  return { ok: false, status: 0, error: String((err as Error)?.message ?? err) };
}

export class NotificationActions {
  /** Ids already marked displayed / seen in this page (one request each). */
  private readonly displayedSent = new Set<string>();
  private readonly seenSent = new Set<string>();

  constructor(private readonly api: Api, private readonly store: Store) {}

  private async run(id: string | null, p: Promise<Notification>): Promise<ActionResult> {
    try {
      const n = await p;
      this.store.apply(n);
      return { ok: true, notification: n };
    } catch (err) {
      // Gone or no longer active: reconcile with the server.
      if (id && err instanceof NotificationApiError && err.isGone) void this.store.refetch();
      return fail(err);
    }
  }

  /** First display of each item (idempotent server-side too). */
  markDisplayed(id: string): void {
    const n = this.store.get(id);
    if (!n || n.displayedAt !== undefined || this.displayedSent.has(id)) return;
    this.displayedSent.add(id);
    void this.run(id, this.api.markDisplayed(id));
  }

  markSeen(ids: Iterable<string>): void {
    for (const id of ids) {
      const n = this.store.get(id);
      if (!n || n.seenAt !== undefined || this.seenSent.has(id)) continue;
      this.seenSent.add(id);
      this.displayedSent.add(id);
      void this.run(id, this.api.markSeen(id));
    }
  }

  async dismiss(id: string): Promise<ActionResult> {
    const r = await this.run(id, this.api.dismiss(id));
    if (r.ok) this.store.drop(id, 'removed');
    return r;
  }

  /** Phase 6: force-hide an app desktop modal (the result is applied like any reply). */
  async forceHide(id: string): Promise<ActionResult> {
    return this.run(id, this.api.forceHide(id));
  }

  async forceRemove(id: string): Promise<ActionResult> {
    const r = await this.run(id, this.api.forceRemove(id));
    if (r.ok) this.store.drop(id, 'removed');
    return r;
  }

  async resolve(id: string, answer: ButtonAnswer | Record<string, unknown>): Promise<ActionResult> {
    const r = await this.run(id, this.api.resolve(id, answer));
    if (r.ok) this.store.drop(id, 'resolved');
    return r;
  }

  interact(id: string, payload: InteractPayload): Promise<ActionResult> {
    return this.run(id, this.api.interact(id, payload));
  }

  /** Clear all (locked ones are skipped by the server). */
  async clearAll(): Promise<ActionResult & { cleared?: number; skippedLocked?: number }> {
    return this.clearSender(undefined);
  }

  /** Phase 5: clear every active notification of one sender (locked ones kept). */
  async clearSender(senderKey: string | undefined): Promise<ActionResult & { cleared?: number; skippedLocked?: number }> {
    try {
      const r = await this.api.clear(senderKey ? { sender: senderKey } : {});
      void this.store.refetch();
      return { ok: true, ...r };
    } catch (err) {
      return fail(err);
    }
  }

  /** Phase 5: delete the history (resolved / removed items) now, optionally of one sender. */
  async clearHistory(senderKey?: string): Promise<ActionResult & { deleted?: number }> {
    try {
      const r = await this.api.clearHistory(senderKey);
      return { ok: true, ...r };
    } catch (err) {
      return fail(err);
    }
  }
}
