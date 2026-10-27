/**
 * Activity-linked notifications (phase 4) — DOM-free.
 *
 * A notification is ACTIVITY-LINKED when it is active and its `context`
 * (`activity` / `instance`) maps to an existing window whose app is the
 * verified sender (or AuraOS). For those:
 *   - the window shows a yellow hint (badge with a count in its title bar,
 *     a warning-coloured edge), the minimized-strip chip and the workspace
 *     pill / ‹ › arrows carry the same marker;
 *   - an in-window panel is always there while the window is visible: a
 *     compact yellow bar (with Answer) unless the user opened it or the
 *     sender forced it (popup); Later / ✕ collapse it back to the bar;
 *   - it never disappears on its own: no pop-up timeout, no eviction, no
 *     queue reflow, no "seen elsewhere" auto-hide. It ends on a user action
 *     (submit / cancel / dismiss / clear), the sender removing or resolving
 *     it, or its own `timeoutMs` (the sender's lifetime);
 *   - its corner pop-up is sticky too (`popupDurationMs` > 0 is ignored).
 * Desktop only for the in-window bar; the phone keeps badges + the list.
 */
import type { Notification } from './api.ts';
import { ownsWindow, windowContext, type ViewDetail } from './dialogs.ts';

export type ViewLookup = (ctx: { instanceId: string; activityId?: string }) => ViewDetail | null;

/** The window this item is linked to (state any but 'none'), or null. */
export function linkedView(n: Notification, lookup: ViewLookup): ViewDetail | null {
  if (n.state !== 'active') return null;
  const ctx = windowContext(n);
  if (!ctx) return null;
  const v = lookup(ctx);
  if (!v || v.state === 'none' || !ownsWindow(n, v)) return null;
  return v;
}

export function isActivityLinked(n: Notification, lookup: ViewLookup): boolean {
  return linkedView(n, lookup) !== null;
}

export interface LinkCounts {
  /** Active linked items per window (the title-bar badge + strip chip). */
  byView: Map<string, number>;
  /** Per workspace, for windows that are NOT on the current one (pill / arrows). */
  byWorkspace: Map<string, number>;
  /** Item ids per window (badge click: one → open it, several → the list). */
  idsByView: Map<string, string[]>;
}

export function linkCounts(items: readonly Notification[], lookup: ViewLookup): LinkCounts {
  const out: LinkCounts = { byView: new Map(), byWorkspace: new Map(), idsByView: new Map() };
  for (const n of items) {
    const v = linkedView(n, lookup);
    if (!v) continue;
    out.byView.set(v.viewId, (out.byView.get(v.viewId) ?? 0) + 1);
    out.idsByView.set(v.viewId, [...(out.idsByView.get(v.viewId) ?? []), n.id]);
    if (v.state === 'other-workspace' && v.workspaceId) out.byWorkspace.set(v.workspaceId, (out.byWorkspace.get(v.workspaceId) ?? 0) + 1);
  }
  return out;
}

/**
 * The collapsed state of an in-window panel — VIEW state owned by the
 * controller (not the DOM), so it survives patches, re-mounts (minimize /
 * restore, workspace switch, slot re-created) and reloads. Per tab
 * (sessionStorage), wrapped; a memory map stands in.
 */
export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
export const COLLAPSE_PREFIX = 'aura.notif.collapsed.';
export class CollapseMemory {
  private readonly mem = new Map<string, boolean>();
  constructor(private readonly storage: StorageLike | null = null) {}
  get(id: string): boolean | undefined {
    if (this.mem.has(id)) return this.mem.get(id);
    try {
      const v = this.storage?.getItem(COLLAPSE_PREFIX + id);
      if (v === '1' || v === '0') { this.mem.set(id, v === '1'); return v === '1'; }
    } catch { /* memory only */ }
    return undefined;
  }
  set(id: string, collapsed: boolean): void {
    this.mem.set(id, collapsed);
    try { this.storage?.setItem(COLLAPSE_PREFIX + id, collapsed ? '1' : '0'); } catch { /* memory only */ }
  }
  clear(id: string): void {
    this.mem.delete(id);
    try { this.storage?.removeItem(COLLAPSE_PREFIX + id); } catch { /* ignore */ }
  }
}

/**
 * How the global surfaces (list card, pop-up, phone sheet) mark an
 * activity-linked item: a yellow accent, and "Go to activity" instead of
 * "Go to task" with the app / window as secondary text. Not linked → null
 * (keep "Go to task"). Lock-screen views never name the window; a
 * redacted (private) one gets nothing at all.
 */
export interface LinkPresentation {
  accent: true;
  buttonLabel: 'Go to activity';
  /** "Notepad · Window 2" — null in lock-screen views. */
  detail: string | null;
  ariaLabel: string;
}
export function linkPresentation(n: Notification, view: ViewDetail | null, appName?: string): LinkPresentation | null {
  if (!view) return null;
  const r = n as Notification & { redacted?: true; lockscreen?: true };
  if (r.redacted) return null;
  if (r.lockscreen) return { accent: true, buttonLabel: 'Go to activity', detail: null, ariaLabel: 'Go to activity — this notification is linked to a window' };
  const detail = [appName || view.appId, n.context?.label?.trim()].filter(Boolean).join(' · ');
  return { accent: true, buttonLabel: 'Go to activity', detail, ariaLabel: `Go to activity: ${detail} — this notification is linked to that window` };
}

/** "2 notifications for this window". */
export function badgeHint(count: number): string {
  return `${count} notification${count === 1 ? '' : 's'} for this window`;
}

/** Badge click: one item → open it there; several → the list (at the first). */
export function badgeAction(ids: readonly string[]): { kind: 'open'; id: string } | { kind: 'list'; id: string } | null {
  if (!ids.length) return null;
  return ids.length === 1 ? { kind: 'open', id: ids[0]! } : { kind: 'list', id: ids[0]! };
}

/**
 * The corner pop-up of a linked item: sticky (stays until ✕ / click /
 * swipe), counts as sticky for the three slots, never hidden by "seen
 * elsewhere". Returns the item as the pop-up logic should see it.
 */
export function stickyPopupView<T extends Pick<Notification, 'id' | 'priority'> & { popupDurationMs?: number }>(n: T, linked: boolean): T {
  return linked ? { ...n, popupDurationMs: 0 } : n;
}
