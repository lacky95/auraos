/**
 * D102: the one notification that points at a held approval.
 *
 * Only the owner's Later creates it (never a requester, never a forced
 * request). It is AuraOS's own item (SYSTEM_CALLER): `locked` (only AuraOS
 * removes it), `high` (a sticky pop-up, announced as important), `private`
 * (a locked screen shows only the public title), with a lifetime that ends
 * with the hold, and a context of kind `approval` whose Review reopens the
 * shell's own owner dialog. It carries no component, so nothing in it can
 * answer anything: the decision is still `POST /api/approvals/<id>/approve`
 * (D17). The approval record stays the single source of truth.
 *
 * What it shows is the server's own display (title, verified requester) and
 * the requester's words labelled as such. Never a password, a secret, a part
 * of one or a payload (D56).
 *
 * It is removed, not turned into an outcome notice, when the request is
 * approved, denied, cancelled or expires (D102); the sweeper removes it at the
 * deadline even if the shell was down, and `reconcileHoldNotices` removes any
 * left over at boot.
 */
import * as core from '@aura/core';
import type { ApprovalRecord } from '@aura/core';

export const NOTICE_PUBLIC_TITLE = 'A request is waiting for your decision';

/** The notification service, as far as hold notices use it. */
export interface HoldNoticeDeps {
  /** Create as SYSTEM_CALLER; the new notification's id. */
  create(input: Record<string, unknown>): Promise<string>;
  /** Remove (reason `completed`); quiet when it is gone already. */
  remove(id: string): Promise<void>;
  /** Active AuraOS notifications of context kind `approval`. */
  listActive(): Promise<Array<{ id: string; approvalId: string }>>;
}

function untilText(at: number): string {
  try {
    return new Date(at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
  } catch {
    return new Date(at).toISOString();
  }
}

/** The create input for a held record. Server data only, no payload. */
export function holdNoticeInput(record: ApprovalRecord, now: number): Record<string, unknown> {
  const d = record.display;
  const lines = [`Requested by ${d.requestedBy} · on hold until ${untilText(record.expiresAt)}.`];
  if (d.reason) lines.push(`In the requester's own words (not verified): ${d.reason}`);
  lines.push('Review opens the request in AuraOS\'s own dialog.');
  return {
    type: 'locked',
    title: d.title.slice(0, 200),
    text: lines.join('\n').slice(0, 4000),
    priority: 'high',
    visibility: 'private',
    publicTitle: NOTICE_PUBLIC_TITLE,
    timeoutMs: Math.max(1000, record.expiresAt - now),
    context: { kind: 'approval', id: record.id, label: 'Review' },
  };
}

export function liveHoldNoticeDeps(): HoldNoticeDeps {
  const svc = () => core.getNotificationService();
  return {
    create: async (input) => {
      const r = await svc().create(input as Parameters<ReturnType<typeof core.getNotificationService>['create']>[0], core.SYSTEM_CALLER);
      return r.notification.id;
    },
    remove: async (id) => {
      try { await svc().removeBySender(id, core.SYSTEM_CALLER); } catch { /* gone already */ }
    },
    listActive: async () => {
      const out: Array<{ id: string; approvalId: string }> = [];
      let cursor: string | undefined;
      do {
        const page = await svc().list({ state: 'active', sender: 'auraos', limit: 200, ...(cursor ? { cursor } : {}) });
        for (const n of page.items) {
          if (n.context?.kind === 'approval') out.push({ id: n.id, approvalId: n.context.id });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return out;
    },
  };
}
