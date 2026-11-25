/**
 * `osClient.user`: the owner, as an app may see them (D49).
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

export class UserApi {
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
