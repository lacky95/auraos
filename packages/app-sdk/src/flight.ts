/**
 * `osClient.flight` — free-flight activities.
 *
 * A flight is a small activity of your app that floats ABOVE every workspace,
 * like the floating virtual keyboard: a call widget, a recorder, a timer, a
 * chat head. The user can drag and resize it, and stick it to a screen edge,
 * where it collapses into a TAB showing your app's glyph plus whatever you put
 * on it (`setBadge`: a short label, a counter, a progress ring, a tint). A tap
 * on the tab opens it again; press-and-hold moves the tab along or onto any
 * edge.
 *
 * While a flight lives, the OS shows an ongoing notification for it (Show /
 * Perch / Close + up to two of your own buttons via `setActions`). The user
 * can't swipe it away — only close the flight.
 *
 * Requirements: `"permissions": ["system.overlay"]` in app.manifest.json and
 * `activityMode: "multi"`. Optional manifest block:
 *
 *   "flight": { "maxPerApp": 1, "defaultSize": { "w": 320, "h": 200 }, "minSize": { "w": 240, "h": 120 } }
 *
 * Typical use (browser, e.g. from your main window):
 *
 *   const f = await osClient.flight.open({ path: '/widget', title: 'Call', size: { w: 320, h: 200 } });
 *   f.setBadge({ label: '00:12', tint: '#2ecc71' });
 *   f.setActions([{ id: 'hangup', label: 'Hang up' }]);
 *   f.on('action', ({ actionId }) => { if (actionId === 'hangup') hangUp(); });
 *   f.setConfirmClose(true);                      // only while a call is live
 *   f.on('closing', (ev) => { if (callLive) { ev.keep(); askHangUp(); } else ev.proceed(); });
 *
 * Closing: a USER close (✕ or the notification's Close) closes at once —
 * unless you turned the veto on with `setConfirmClose(true)`. Then you get
 * `closing` and have `vetoMs` (3 s) to call `ev.keep()` — the flight unfolds
 * so you can ask (e.g. "Hang up?") — or `ev.proceed()` to let it close now.
 * A second Close, or no answer, closes it. Turn the veto on only while there
 * is something to lose, so closing stays instant otherwise. `close()` from
 * your own code closes at once, without a veto.
 *
 * Modes — how a flight shows up (the app picks the default, the user can
 * switch between the `modes` you allow):
 *   • 'free' — a floating panel anywhere; folds into its edge tab.
 *   • 'edge' — a drawer stuck to a screen edge, opened from its tab and hidden
 *     back into it; any size from a small panel to the whole edge
 *     (`edgeSize: { length: 'full', depth: 360 }`).
 *
 *   await osClient.flight.open({ mode: 'edge', edge: 'right', edgeSize: { length: 'full', depth: 360 } });
 *
 * Inside the flight's own page, `await osClient.flight.current()` returns the
 * handle for itself (or null when the page is not a flight).
 *
 * Events (`on`) are browser-only (they ride the OS event stream); the calls
 * work server-side too.
 */

import type { OsClient } from './OsClient.js';
import { getAppBasePath } from './context.js';

export type FlightEdge = 'left' | 'right' | 'top' | 'bottom';
export interface FlightRect { x: number; y: number; w: number; h: number }
export interface FlightBadge {
  /** ≤ 12 chars, e.g. "03:12", "REC", "MUTE". */
  label?: string;
  /** Counter dot; 0 hides it. */
  count?: number;
  /** Ring around the tab, 0..1; null hides it. */
  progress?: number | null;
  /** CSS colour of the tab (default: the theme accent). */
  tint?: string;
}
export interface FlightAction { id: string; label: string }
/** How a flight shows up: a free floating panel, or a drawer stuck to an edge. */
export type FlightMode = 'free' | 'edge';
/** Where the flight's tab sits (both modes). */
export interface FlightAnchor { edge: FlightEdge; pos: number }
/** Edge-mode drawer size: along the edge (`'full'` = whole edge) × into the screen. */
export interface FlightEdgeSize { length: number | 'full'; depth: number }
export interface FlightState {
  mode: FlightMode;
  /** Modes the user may switch between (absent = all). */
  modes?: FlightMode[];
  /** Free-mode rect. */
  rect: FlightRect | null;
  size?: { w: number; h: number };
  minSize?: { w: number; h: number };
  anchor: FlightAnchor;
  /** Where the drawer was last docked (informational; docking uses `anchor`). */
  edgeAnchor?: FlightAnchor;
  /** Folded into its tab (free: perched, edge: hidden). */
  folded: boolean;
  edgeSize: FlightEdgeSize;
  /** Compatibility alias: `folded ? anchor : null`. */
  perch: FlightAnchor | null;
  badge?: FlightBadge;
  actions?: FlightAction[];
  /** The close veto is on (see `setConfirmClose`). */
  confirmClose?: boolean;
}

export interface FlightOpenOptions {
  /** Page inside your app the flight shows (default `/`; your onActivityCreate may override). */
  path?: string;
  title?: string;
  /** Passed to your `onActivityCreate` hook as `data` (it also gets `presentation: 'flight'`). */
  data?: Record<string, unknown>;
  /** Free / edge (default: the manifest's `flight.defaultMode`, else 'free'). */
  mode?: FlightMode;
  /** Which modes the user may switch between (default: the manifest's, else both). */
  modes?: FlightMode[];
  /** Edge of the tab / the drawer, and the position along it (0..1). */
  edge?: FlightEdge;
  pos?: number;
  /** Edge-mode drawer size. */
  edgeSize?: FlightEdgeSize;
  /** Start folded into the tab. */
  folded?: boolean;
  size?: { w: number; h: number };
  minSize?: { w: number; h: number };
  /** Open already perched on an edge (`pos` 0..1 along it). Same as `{ edge, pos, folded: true }`. */
  perched?: { edge: FlightEdge; pos?: number };
  badge?: FlightBadge;
  actions?: FlightAction[];
  /** Instance to open on (default: this app's own instance). */
  instanceId?: string;
}

export interface FlightClosingEvent {
  reason: string;
  vetoMs: number;
  /** Keep the flight open (within `vetoMs`). It unfolds so you can ask the user. */
  keep(): Promise<boolean>;
  /** Nothing to ask after all: close it now instead of after `vetoMs`. */
  proceed(): Promise<boolean>;
}

export interface FlightEvents {
  /** Any change: moved, perched, unfolded, badge/actions/title. */
  change: { flight: FlightState; title?: string };
  /** Folded into its tab (either mode). */
  perched: { edge: FlightEdge; pos: number };
  /** Opened from its tab (either mode). */
  unfolded: { rect: FlightRect | null };
  /** The user (or the app) switched between free and edge. */
  mode: { mode: FlightMode };
  /** The user asked to close — see `FlightClosingEvent.keep`. */
  closing: FlightClosingEvent;
  /** One of your `setActions` buttons was pressed on the notification. */
  action: { actionId: string };
  /** It became a normal window (the user pressed ⧉). */
  landed: Record<string, never>;
  closed: Record<string, never>;
}

type Handler<K extends keyof FlightEvents> = (ev: FlightEvents[K]) => void;

const apiBase = (): string =>
  typeof window !== 'undefined' ? '' : (process.env['OS_API_BASE'] ?? 'http://localhost:3000');

async function call(path: string, method: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text;
    try { msg = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* plain text */ }
    throw new Error(`flight: ${method} ${path} → ${res.status} ${msg}`.trim());
  }
  return res;
}

const act = (id: string, suffix = '') => `/api/activities/${encodeURIComponent(id)}${suffix}`;

/** One flight. Methods return once the OS has the change. */
export class FlightHandle {
  private handlers = new Map<keyof FlightEvents, Set<(ev: never) => void>>();
  private unsubscribe: (() => void) | null = null;
  private lastPerched: boolean | null = null;
  private lastMode: FlightMode | null = null;

  constructor(private readonly client: OsClient, readonly activityId: string, private state: FlightState | null = null) {}

  /** The last state the OS reported (null until known). */
  get flight(): FlightState | null { return this.state; }

  async refresh(): Promise<FlightState | null> {
    const res = await call(act(this.activityId, '/flight'), 'GET');
    const body = await res.json() as { presentation?: string; flight?: FlightState };
    this.state = body.presentation === 'flight' ? body.flight ?? null : null;
    return this.state;
  }

  private async patch(p: Record<string, unknown>): Promise<FlightState> {
    const res = await call(act(this.activityId, '/flight'), 'PATCH', p);
    const body = await res.json() as { flight: FlightState };
    this.state = body.flight;
    return body.flight;
  }

  /** Fold it into a tab on an edge (default: right edge, middle). */
  perch(edge: FlightEdge = 'right', pos = 0.5): Promise<FlightState> { return this.patch({ anchor: { edge, pos }, folded: true }); }
  /** Open it from its tab. */
  unfold(): Promise<FlightState> { return this.patch({ folded: false }); }
  /** Fold it into its tab where it is (either mode). */
  hide(): Promise<FlightState> { return this.patch({ folded: true }); }
  /** Same as `unfold()`. */
  show(): Promise<FlightState> { return this.unfold(); }
  /** Switch between a free panel and an edge drawer (must be one of `modes`). */
  setMode(mode: FlightMode): Promise<FlightState> {
    // Docking opens the drawer where the badge was put last (`anchor`).
    return this.patch({ mode, folded: false, ...(mode === 'edge' && this.state?.anchor ? { anchor: this.state.anchor } : {}) });
  }
  /** Edge-mode drawer size, e.g. `{ length: 'full', depth: 320 }`. */
  setEdgeSize(size: Partial<FlightEdgeSize>): Promise<FlightState> { return this.patch({ edgeSize: size }); }
  /** Move / resize (the shell clamps it to the screen). */
  setRect(rect: FlightRect): Promise<FlightState> { return this.patch({ rect }); }
  /** What the tab shows; `null` clears. Replaces the previous badge. */
  setBadge(badge: FlightBadge | null): Promise<FlightState> { return this.patch({ badge }); }
  setTitle(title: string): Promise<FlightState> { return this.patch({ title }); }
  /** Up to two buttons on the ongoing notification → `on('action')`. */
  setActions(actions: FlightAction[] | null): Promise<FlightState> { return this.patch({ actions }); }
  /**
   * Ask before a USER close (on) — you then get `closing` with a veto window —
   * or let it close at once (off, the default). Turn it on only while there is
   * something to lose (a live call, unsaved input).
   */
  setConfirmClose(on: boolean): Promise<FlightState> { return this.patch({ confirmClose: on }); }
  /** Turn it into a normal window on the active workspace. */
  async land(): Promise<void> { await call(act(this.activityId, '/flight/land'), 'POST', {}); }
  /** Close it now (your own decision — no veto round). */
  async close(): Promise<void> { await call(act(this.activityId, '/close'), 'POST'); }
  /** Keep a flight the user is closing (only within the veto window). */
  async keep(): Promise<boolean> {
    try { await call(act(this.activityId, '/flight/keep'), 'POST', {}); return true; }
    catch { return false; }
  }
  /** Let a pending user close go through now. */
  async proceed(): Promise<boolean> {
    try { await call(act(this.activityId, '/flight/proceed'), 'POST', {}); return true; }
    catch { return false; }
  }

  /** Listen for flight events (browser only). Returns an unsubscribe. */
  on<K extends keyof FlightEvents>(event: K, fn: Handler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) { set = new Set(); this.handlers.set(event, set); }
    const s = set;
    s.add(fn as (ev: never) => void);
    this.ensureSubscribed();
    return () => { s.delete(fn as (ev: never) => void); };
  }

  /** Stop listening to all events. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.handlers.clear();
  }

  private emit<K extends keyof FlightEvents>(event: K, payload: FlightEvents[K]): void {
    for (const fn of (this.handlers.get(event) ?? []) as Set<Handler<K>>) {
      try { fn(payload); } catch (err) { console.error(`[aura flight] ${String(event)} handler failed`, err); }
    }
  }

  private ensureSubscribed(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.client.subscribeOsEvents<Record<string, unknown>>(
      ['activity:flightChanged', 'activity:flightClosing', 'activity:flightAction', 'activity:closed'],
      (ev) => {
        if (ev['activityId'] !== this.activityId) return;
        switch (ev.type) {
          case 'activity:flightChanged': {
            if (ev['presentation'] !== 'flight') { this.state = null; this.emit('landed', {}); return; }
            const f = ev['flight'] as FlightState | undefined;
            if (!f) return;
            this.state = f;
            this.emit('change', { flight: f, ...(typeof ev['title'] === 'string' ? { title: ev['title'] as string } : {}) });
            const folded = f.folded ?? !!f.perch;
            if (this.lastPerched !== null && folded !== this.lastPerched) {
              if (folded) this.emit('perched', f.anchor ?? f.perch!); else this.emit('unfolded', { rect: f.rect });
            }
            this.lastPerched = folded;
            if (this.lastMode !== null && f.mode && f.mode !== this.lastMode) this.emit('mode', { mode: f.mode });
            if (f.mode) this.lastMode = f.mode;
            return;
          }
          case 'activity:flightClosing':
            this.emit('closing', {
              reason: String(ev['reason'] ?? 'user'),
              vetoMs: Number(ev['vetoMs'] ?? 0),
              keep: () => this.keep(),
              proceed: () => this.proceed(),
            });
            return;
          case 'activity:flightAction':
            this.emit('action', { actionId: String(ev['actionId'] ?? '') });
            return;
          case 'activity:closed':
            this.emit('closed', {});
            this.dispose();
            return;
        }
      },
    );
    this.lastPerched = this.state ? (this.state.folded ?? !!this.state.perch) : null;
    this.lastMode = this.state?.mode ?? null;
  }
}

export class FlightApi {
  constructor(private readonly client: OsClient) {}

  /** Open a new flight of this app. Needs `system.overlay`. */
  async open(opts: FlightOpenOptions = {}): Promise<FlightHandle> {
    const instanceId = opts.instanceId ?? ownInstanceId();
    if (!instanceId) throw new Error('flight: cannot tell this app\'s instance id — pass opts.instanceId');
    const flight: Partial<FlightState> & { size?: { w: number; h: number } } = {};
    if (opts.size) flight.size = opts.size;
    if (opts.minSize) flight.minSize = opts.minSize;
    if (opts.mode) flight.mode = opts.mode;
    if (opts.modes) flight.modes = opts.modes;
    if (opts.edgeSize) flight.edgeSize = opts.edgeSize;
    if (opts.edge) flight.anchor = { edge: opts.edge, pos: opts.pos ?? 0.5 };
    if (opts.folded !== undefined) flight.folded = opts.folded;
    if (opts.perched) { flight.anchor = { edge: opts.perched.edge, pos: opts.perched.pos ?? 0.5 }; flight.folded = true; }
    if (opts.badge) flight.badge = opts.badge;
    if (opts.actions) flight.actions = opts.actions;
    const res = await call(`/api/instances/${encodeURIComponent(instanceId)}/activities`, 'POST', {
      presentation: 'flight',
      flight,
      data: opts.data ?? {},
      ...(opts.path ? { path: opts.path } : {}),
    });
    const body = await res.json() as { activityId: string; activity?: { flight?: FlightState } };
    const handle = new FlightHandle(this.client, body.activityId, body.activity?.flight ?? null);
    if (opts.title) await handle.setTitle(opts.title).catch(() => undefined);
    return handle;
  }

  /** A handle for an existing flight (e.g. one you opened before a reload). */
  get(activityId: string): FlightHandle {
    return new FlightHandle(this.client, activityId);
  }

  /**
   * The flight this page is running in, or null when it is not a flight
   * (a normal window, or no activity context).
   */
  async current(): Promise<FlightHandle | null> {
    const id = this.client.activity.getActivityId();
    if (!id) return null;
    const h = new FlightHandle(this.client, id);
    try { return (await h.refresh()) ? h : null; } catch { return null; }
  }

  /**
   * Turn this page's own window into a flight (it leaves its workspace and
   * floats). Needs `system.overlay`. Returns null without an activity context.
   */
  async takeOff(rect?: FlightRect): Promise<FlightHandle | null> {
    const id = this.client.activity.getActivityId();
    if (!id) return null;
    const res = await call(act(id, '/flight/takeoff'), 'POST', rect ? { rect } : {});
    const body = await res.json() as { flight: FlightState };
    return new FlightHandle(this.client, id, body.flight);
  }
}

/** `/api/proxy/<instanceId>` in the browser, APP_INSTANCE_ID on the server. */
function ownInstanceId(): string | null {
  if (typeof process !== 'undefined' && process.env?.['APP_INSTANCE_ID']) return process.env['APP_INSTANCE_ID'];
  try {
    const m = getAppBasePath().match(/^\/api\/proxy\/([^/]+)/);
    return m ? decodeURIComponent(m[1]!) : null;
  } catch { return null; }
}
