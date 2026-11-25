/**
 * `osClient.user`: the user this app acts for (D46), and the owner's
 * confirmation (D49).
 *
 *   const me = await osClient.user.get();
 *   const name = me.profile.displayName ?? me.username ?? 'you';
 *   await saveNote({ createdBy: me.ref });   // persist `ref`, never `userId`
 *   const off = osClient.user.onChange((me) => render(me));
 *
 * `get()` returns who the request acts for, as AuraOS verified it: a page
 * through its App Host gateway, a server with its instance token. Every
 * `profile` field is optional: AuraOS sends the fields this app may read
 * (the basic ones, plus any the owner granted as `user.profile.<field>`),
 * so check a field is there before using it. `userId` is opaque and local
 * to this Aura; store `ref` (`userId@systemId`) for anything you persist.
 * `verified` is true only when a live sign-in of that user stands behind
 * the call.
 *
 *   const { confirmed, approvalId } = await osClient.user.confirm({
 *     action: 'delete-project', reason: 'Deletes "Q3 plan" and its files', level: 'fresh',
 *   });
 *
 * `confirm()` asks AuraOS to show its own dialog: the verified app, the
 * action, and your `reason` labelled as your words. `level: 'fresh'` also
 * asks for the owner's password, which only AuraOS ever sees. The app gets
 * back only `{ confirmed, approvalId? }`: it cannot tell a cancel from a wrong
 * password, and there is no API that checks a password, by design.
 *
 * `approvalId` is single use and bound to this app's instance, the user and
 * the action. Your server proves the confirmation by using it up once:
 *
 *   await osClient.user.consumeConfirmation({ approvalId, action: 'delete-project' });
 *
 * Needs the `user.confirm` permission in app.manifest.json.
 */
import { postToShell, isFromShell } from './channel.js';
import { appHostRuntime, isBrowser, osAuthHeaders, osBase } from './os-auth.js';

/**
 * Profile fields an app may get. All optional, and more may come without an
 * SDK release: read unknown ones from the index signature.
 */
export interface UserProfileView {
  displayName?: string;
  /** BCP 47, e.g. `en` or `de-AT`. */
  locale?: string;
  /** An https URL or a data:image URL. */
  avatar?: string;
  [field: string]: string | undefined;
}

export interface AuraUser {
  /** Opaque and local to this Aura. Compare it, never parse it or persist it across systems. */
  userId: string;
  username?: string;
  role?: string;
  isOwner: boolean;
  /** A live sign-in of this user stands behind the call. */
  verified: boolean;
  /** The Aura this user belongs to (D47). */
  systemId: string;
  /** `userId@systemId`: what to store for "created by", sharing and the like. */
  ref: string;
  profile: UserProfileView;
}

/** What `UserApi` needs from OsClient: the OS event stream. */
interface EventSource_ {
  subscribeOsEvents<T>(topics: readonly string[], handler: (ev: { type: string } & T) => void): () => void;
}

export type ConfirmLevel = 'session' | 'fresh';

export interface ConfirmOptions {
  /** A short identifier for what is confirmed, e.g. `delete-project` (letters, digits, `.`, `_`, `:`, `-`). */
  action: string;
  /** Shown to the owner, labelled as the app's words. */
  reason?: string;
  /** `session` (default): a click. `fresh`: also the owner's password. */
  level?: ConfirmLevel;
}

export interface ConfirmResult {
  confirmed: boolean;
  /** Present only when confirmed: single use, for your server to consume. */
  approvalId?: string;
}

export class UserConfirmError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'UserConfirmError';
  }
}

const NO: ConfirmResult = Object.freeze({ confirmed: false });

function requestId(): string {
  const c = globalThis.crypto;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class UserError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`user: ${code} (${status})`);
    this.name = 'UserError';
  }
}

export class UserApi {
  constructor(private readonly events?: EventSource_) {}

  /**
   * The user this app acts for, with the profile fields it may read.
   * `opts.token`: server side, another instance token than `AURA_INSTANCE_TOKEN`.
   * Rejects with `UserError` (401 without a verified caller).
   */
  async get(opts: { token?: string } = {}): Promise<AuraUser> {
    const url = `${osBase({ mode: isBrowser() ? 'relative' : 'server' })}/api/user/me`;
    const res = await fetch(url, {
      headers: { accept: 'application/json', ...osAuthHeaders(url, opts.token !== undefined ? { token: opts.token } : {}) },
    });
    const body = await res.json().catch(() => null) as (AuraUser & { error?: string }) | null;
    if (!res.ok || !body || typeof body.userId !== 'string') throw new UserError(res.status, body?.error ?? 'unavailable');
    return { ...body, profile: body.profile && typeof body.profile === 'object' ? body.profile : {} };
  }

  /**
   * Calls `cb` with the user, read again, whenever their profile changes
   * (the OS event `user:changed`, which itself carries no values).
   * Browser only; a no-op elsewhere. Returns the unsubscribe function.
   */
  onChange(cb: (user: AuraUser) => void): () => void {
    if (!this.events || !isBrowser()) return () => undefined;
    let latest = 0;
    return this.events.subscribeOsEvents(['user:changed'], () => {
      const mine = ++latest;
      // Only the newest read is delivered when changes come in a burst.
      this.get().then((u) => { if (mine === latest) cb(u); }).catch(() => undefined);
    });
  }
  /**
   * Ask the owner to confirm `action` in AuraOS's dialog. Resolves
   * `{ confirmed: false }` when they decline, the dialog cannot be shown, or
   * the request expires. Rejects (UserConfirmError) only on a bad request:
   * an invalid action, a missing permission, or outside an App Host page.
   */
  async confirm(opts: ConfirmOptions): Promise<ConfirmResult> {
    if (!isBrowser() || !appHostRuntime()) {
      throw new UserConfirmError('no-shell', 'user.confirm needs an App Host page inside AuraOS');
    }
    const res = await fetch(`${osBase()}/api/approvals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'user.confirm', payload: { action: opts.action }, level: opts.level ?? 'session',
        ...(opts.reason ? { reason: opts.reason } : {}),
      }),
    });
    const body = await res.json().catch(() => ({})) as { id?: string; error?: string; message?: string };
    if (!res.ok || typeof body.id !== 'string') {
      // The owner blocked this app, or a request is already waiting: a "no", not a bug.
      if (res.status === 403 && body.error === 'blocked') return NO;
      if (res.status === 429) return NO;
      throw new UserConfirmError(body.error ?? `http-${res.status}`, body.message ?? `confirm refused (${res.status})`);
    }
    return this.askShell(body.id, opts.level ?? 'session');
  }

  /** Post the request to the verified shell and wait for its one answer. */
  private askShell(approvalId: string, level: ConfirmLevel): Promise<ConfirmResult> {
    const id = requestId();
    return new Promise((resolve) => {
      const onMessage = (ev: MessageEvent) => {
        if (!isFromShell(ev)) return;
        const d = ev.data as { type?: unknown; requestId?: unknown; confirmed?: unknown; approvalId?: unknown } | null;
        if (!d || d.type !== 'aura.user.confirm.result' || d.requestId !== id) return;
        window.removeEventListener('message', onMessage);
        resolve(d.confirmed === true && typeof d.approvalId === 'string'
          ? { confirmed: true, approvalId: d.approvalId }
          : NO);
      };
      window.addEventListener('message', onMessage);
      postToShell({ type: 'aura.user.confirm.request', requestId: id, approvalId, level });
    });
  }

  /**
   * On your server: use up a confirmation the page received, once. Resolves
   * true only for an approved, unexpired, unused id of this instance and
   * exactly this `action`.
   */
  async consumeConfirmation(opts: { approvalId: string; action: string; token?: string }): Promise<boolean> {
    const url = `${osBase({ mode: 'server' })}/api/approvals/${encodeURIComponent(opts.approvalId)}/consume`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...osAuthHeaders(url, opts.token !== undefined ? { token: opts.token } : {}) },
      body: JSON.stringify({ payload: { action: opts.action } }),
    });
    return res.ok;
  }
}
