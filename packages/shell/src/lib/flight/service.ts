/**
 * Free-flight activities — the server half (DOM-free).
 *
 * A flight is an `AppActivity` with `presentation: 'flight'` (core
 * AppManager owns its geometry). This module adds what the OS promises
 * around it:
 *
 *   • One ongoing notification per flight, sent BY THE SHELL on the app's
 *     behalf (SYSTEM_CALLER, sender name/icon = the app): `locked` + pinned,
 *     so it can't be swiped away while the flight lives — no
 *     `notifications.locked` grant needed by the app. Buttons Show / Perch /
 *     Close plus up to two app actions (`flight.actions`).
 *   • The close veto, OPT-IN: by default a user Close closes at once. An app
 *     that may need to ask first ("hang up?") turns it on while it matters
 *     (`confirmClose`, PATCH …/flight); a user Close then emits
 *     `activity:flightClosing` and the app has `CLOSE_VETO_MS` to keep the
 *     flight (POST …/flight/keep) or let it go now (POST …/flight/proceed).
 *     A second Close while one is pending, or no answer, closes it.
 *     Force-removing the notification closes at once.
 *   • Removing the notification when the flight closes or lands, creating one
 *     when a window takes off.
 *
 * Listeners live on the process-wide OsEventBus; a hot-swapped shell build
 * (shell-watch) disposes the previous generation's listeners first.
 */

// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import type { AppActivity, FlightState } from '@aura/core';
import { loadFlightMemory, noteFlight } from './memory.js';

export const CLOSE_VETO_MS = 3_000;

// Notification component ids are [A-Za-z0-9_.-]; app buttons are `app.<index>`
// into `flight.actions` (app action ids may contain anything).
const BTN_SHOW = 'flight.show';
const BTN_PERCH = 'flight.perch';
const BTN_CLOSE = 'flight.close';
const APP_BTN = 'app.';

type CreateInput = Parameters<ReturnType<typeof core.getNotificationService>['create']>[0];
type Mgr = ReturnType<typeof core.getAppManager>;
type Bus = { on: (ev: string, fn: (p: any) => void) => void; off: (ev: string, fn: (p: any) => void) => void; emit: (ev: string, p: unknown) => void };

const bus = () => core.OsEventBus as unknown as Bus;
const svc = () => core.getNotificationService();
const mgr = (): Mgr => core.getAppManager();

export type CloseResult = 'closing' | 'closed' | 'not-found';

class FlightService {
  /** activityId → notification id. */
  private readonly notes = new Map<string, string>();
  /** Reverse map for interactions. */
  private readonly byNote = new Map<string, string>();
  /** Notification ids we removed ourselves (their removal is no user close). */
  private readonly removingNotes = new Set<string>();
  /** Flights whose app asked to confirm a user close (opt-in veto). */
  private readonly confirm = new Set<string>();
  /** Pending user closes (veto window). */
  private readonly closing = new Map<string, ReturnType<typeof setTimeout>>();
  /** Last edge a flight perched on — Perch from the notification goes back there. */
  private readonly lastPerch = new Map<string, NonNullable<FlightState['perch']>>();
  /** Content last sent per flight — unchanged content is not re-sent. */
  private readonly sent = new Map<string, string>();
  /** Serialises notification calls per flight (create lands before updates). */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly listeners: Array<[Bus, string, (p: any) => void]> = [];

  /** Keep the previous generation's notifications (no duplicates after a hot swap). */
  adopt(prev: FlightService): void {
    // `prev` may be an older build's object: read every map defensively.
    const old = prev as unknown as Partial<Record<'notes' | 'lastPerch' | 'sent', Map<string, unknown>>>;
    for (const [a, n] of old.notes ?? []) { this.notes.set(a, n as string); this.byNote.set(n as string, a); }
    for (const [a, p] of old.lastPerch ?? []) this.lastPerch.set(a, p as NonNullable<FlightState['perch']>);
    for (const [a, j] of old.sent ?? []) this.sent.set(a, j as string);
    for (const a of (prev as unknown as { confirm?: Set<string> }).confirm ?? []) this.confirm.add(a);
  }

  start(): void {
    void loadFlightMemory();
    this.on('activity:opened', (ev) => {
      if (ev.presentation !== 'flight') return;
      this.syncNote(ev.activityId);
      noteFlight(ev.appId, ev.path, ev.flight);
    });
    this.on('activity:flightChanged', (ev) => {
      if (ev.presentation === 'flight') noteFlight(ev.appId, ev.path, ev.flight);
      if (ev.flight?.perch) this.lastPerch.set(ev.activityId, ev.flight.perch);
      if (ev.presentation === 'flight') this.syncNote(ev.activityId);
      else this.dropNote(ev.activityId);
    });
    this.on('activity:closed', (ev) => {
      this.cancelClose(ev.activityId);
      this.confirm.delete(ev.activityId);
      this.lastPerch.delete(ev.activityId);
      this.dropNote(ev.activityId);
    });
    this.on('notification:interacted', (ev) => {
      const activityId = this.byNote.get(ev.id);
      if (activityId) void this.onInteract(activityId, ev.id);
    });
    this.on('notification:removed', (ev) => {
      const activityId = this.byNote.get(ev.id);
      if (!activityId || this.removingNotes.has(ev.id)) return;
      // The user force-removed the ongoing notification: that IS a close, no veto.
      this.notes.delete(activityId);
      this.byNote.delete(ev.id);
      const a = mgr().getActivity(activityId);
      if (a?.presentation === 'flight') void mgr().closeActivity(activityId);
    });
    // Flights that already exist (a hot swap of this module).
    for (const a of mgr().getAllActivities()) if (a.presentation === 'flight') this.syncNote(a.activityId);
  }

  dispose(): void {
    for (const [b, ev, fn] of this.listeners) b.off(ev, fn);
    this.listeners.length = 0;
    for (const t of this.closing.values()) clearTimeout(t);
    this.closing.clear();
  }

  private on(ev: string, fn: (p: any) => void): void {
    const safe = (p: any) => { try { fn(p); } catch (err) { console.warn(`[flight] ${ev}: ${(err as Error).message}`); } };
    const b = bus();
    b.on(ev, safe);
    this.listeners.push([b, ev, safe]);
  }

  // ─── Close with veto ─────────────────────────────────────────────────

  /** A user Close (flight ✕, notification Close). */
  requestClose(activityId: string, reason: string): CloseResult {
    const a = mgr().getActivity(activityId);
    if (!a || a.presentation !== 'flight') return 'not-found';
    // No veto asked for, or a second Close while the app is still deciding: close now.
    if (!this.confirm.has(activityId) || this.closing.has(activityId)) {
      this.cancelClose(activityId);
      void mgr().closeActivity(activityId);
      return 'closed';
    }
    this.closing.set(activityId, setTimeout(() => {
      this.closing.delete(activityId);
      void mgr().closeActivity(activityId);
    }, CLOSE_VETO_MS));
    bus().emit('activity:flightClosing', {
      activityId, parentInstanceId: a.parentInstanceId, appId: a.appId, reason, vetoMs: CLOSE_VETO_MS,
    });
    return 'closing';
  }

  /** The app keeps a closing flight: it un-perches so the app can ask the user. */
  keep(activityId: string): boolean {
    if (!this.closing.has(activityId)) return false;
    this.cancelClose(activityId);
    const a = mgr().getActivity(activityId);
    if (!a) return false;
    if (a.flight?.folded ?? a.flight?.perch) mgr().updateFlight(activityId, { folded: false });
    bus().emit('activity:flightKept', { activityId, parentInstanceId: a.parentInstanceId, appId: a.appId });
    return true;
  }

  /** The app lets a pending close go through now (no need to wait out the veto). */
  proceed(activityId: string): boolean {
    if (!this.closing.has(activityId)) return false;
    this.cancelClose(activityId);
    void mgr().closeActivity(activityId);
    return true;
  }

  /** Turn the close veto on / off for a flight (the app's call). */
  setConfirmClose(activityId: string, on: boolean): void {
    if (on) this.confirm.add(activityId); else this.confirm.delete(activityId);
  }

  confirmsClose(activityId: string): boolean { return this.confirm.has(activityId); }

  isClosing(activityId: string): boolean { return this.closing.has(activityId); }

  private cancelClose(activityId: string): void {
    const t = this.closing.get(activityId);
    if (t) clearTimeout(t);
    this.closing.delete(activityId);
  }

  // ─── Ongoing notification ────────────────────────────────────────────

  private async onInteract(activityId: string, noteId: string): Promise<void> {
    const n = await svc().get(noteId).catch(() => null);
    const cid = n?.lastInteraction?.componentId;
    if (!cid) return;
    const a = mgr().getActivity(activityId);
    if (!a || a.presentation !== 'flight') return;
    // Fold / unfold at the flight's own anchor (its tab), in either mode.
    if (cid === BTN_SHOW) mgr().updateFlight(activityId, { folded: false });
    else if (cid === BTN_PERCH) mgr().updateFlight(activityId, { folded: true });
    else if (cid === BTN_CLOSE) this.requestClose(activityId, 'notification');
    else if (cid.startsWith(APP_BTN)) {
      const action = a.flight?.actions?.[Number(cid.slice(APP_BTN.length))];
      if (!action) return;
      bus().emit('activity:flightAction', {
        activityId, parentInstanceId: a.parentInstanceId, appId: a.appId, actionId: action.id,
      });
    }
  }

  private content(a: AppActivity): { title: string; text: string; components: unknown[] } {
    const m = mgr().getManifest(a.appId);
    const appName = m?.name ?? a.appId;
    const f = a.flight;
    const folded = f?.folded ?? !!f?.perch;
    const edgeMode = f?.mode === 'edge';
    const side = f?.anchor?.edge ?? f?.perch?.edge ?? 'right';
    const components: unknown[] = [];
    components.push(folded
      ? { kind: 'button', id: BTN_SHOW, label: 'Show', variant: 'primary' }
      : { kind: 'button', id: BTN_PERCH, label: edgeMode ? 'Hide' : 'Perch', variant: 'secondary' });
    (f?.actions ?? []).forEach((act, i) => components.push({ kind: 'button', id: `${APP_BTN}${i}`, label: act.label, variant: 'secondary' }));
    components.push({ kind: 'button', id: BTN_CLOSE, label: 'Close', variant: 'tertiary' });
    return {
      // Deliberately no badge label / progress here: apps update those every
      // second or faster, and each change would re-patch the notification.
      title: a.title && a.title !== appName ? `${appName} — ${a.title}` : appName,
      text: folded
        ? `${edgeMode ? 'Hidden' : 'Perched'} on the ${side} edge — tap its tab to open it.`
        : edgeMode ? `Open at the ${side} edge.` : 'Floating above your desktop.',
      components,
    };
  }

  private queue(activityId: string, fn: () => Promise<unknown>): void {
    const prev = this.chains.get(activityId) ?? Promise.resolve();
    const next = prev.then(fn).catch((err: unknown) => {
      const details = (err as { details?: unknown }).details;
      console.warn(`[flight] notification ${activityId}: ${(err as Error).message}${details ? ` ${JSON.stringify(details).slice(0, 400)}` : ''}`);
    });
    this.chains.set(activityId, next);
    void next.then(() => { if (this.chains.get(activityId) === next) this.chains.delete(activityId); });
  }

  /** Create or update the flight's notification from the current activity. */
  private syncNote(activityId: string): void {
    this.queue(activityId, async () => {
      const a = mgr().getActivity(activityId);
      if (!a || a.presentation !== 'flight') return;
      const content = this.content(a);
      const json = JSON.stringify(content);
      const id = this.notes.get(activityId);
      if (id && this.sent.get(activityId) === json) return; // badge-only changes: nothing to show
      if (id) {
        this.sent.set(activityId, json);
        try { await svc().update(id, content as Parameters<ReturnType<typeof svc>['update']>[1], core.SYSTEM_CALLER); return; }
        catch { this.notes.delete(activityId); this.byNote.delete(id); /* gone: recreate */ }
      }
      const m = mgr().getManifest(a.appId);
      const r = await svc().create({
        ...content,
        type: 'locked',
        pinned: true,
        priority: 'medium',
        visibility: 'public',
        context: { kind: 'custom', id: `flight:${activityId}`, appId: a.appId, label: 'Flight' },
        sender: { name: m?.name ?? a.appId, ...(m?.icon && m.icon.length <= 2048 ? { icon: m.icon } : {}) },
      } as CreateInput, core.SYSTEM_CALLER);
      this.notes.set(activityId, r.notification.id);
      this.byNote.set(r.notification.id, activityId);
      this.sent.set(activityId, json);
    });
  }

  private dropNote(activityId: string): void {
    this.queue(activityId, async () => {
      const id = this.notes.get(activityId);
      this.sent.delete(activityId);
      if (!id) return;
      this.notes.delete(activityId);
      this.removingNotes.add(id);
      try { await svc().removeBySender(id, core.SYSTEM_CALLER); }
      finally { this.byNote.delete(id); this.removingNotes.delete(id); }
    });
  }
}

const KEY = Symbol.for('aura.flight.service');
type G = typeof globalThis & { [KEY]?: FlightService };

/** Start (or restart, after a hot swap) the flight service. Idempotent per generation. */
export function startFlightService(): FlightService {
  const g = globalThis as G;
  const prev = g[KEY];
  try { prev?.dispose(); } catch { /* an older build's object */ }
  const s = new FlightService();
  g[KEY] = s;
  if (prev) {
    try { s.adopt(prev); } catch (err) { console.warn(`[flight] could not adopt the previous service: ${(err as Error).message}`); }
  }
  s.start();
  return s;
}

export function flightService(): FlightService {
  return (globalThis as G)[KEY] ?? startFlightService();
}
