/**
 * Free-flight activities — the shell's flight layer (browser).
 *
 * Every activity with `presentation: 'flight'` is rendered here, above all
 * workspaces, instead of as a layout slot. A flight has a MODE — how it shows
 * up — and can be FOLDED into its tab in either mode:
 *
 *   • free — a floating panel: header (app glyph, title, perch ⇤, dock to
 *     edge, pop in, close ✕) + the app iframe; drag by the header, resize from
 *     the sides or the bottom (+ corners), like a Free Window. Dragging it with
 *     the pointer near a screen edge shows a glow; releasing there folds it.
 *   • edge — a drawer flush against its anchor edge (lib/flight/geometry.ts
 *     `edgeRect`), app-sized from small to the whole edge, with an edge title
 *     bar (hide, float, pop in, close). A click on the title bar hides it;
 *     drag it along the edge to slide it, away from the edge to tear it off
 *     into free mode; resize from the inner side and the ends. While open,
 *     no tab is shown — the drawer itself is the handle.
 *   • folded — the panel is hidden (iframe stays mounted, so the app keeps
 *     running and its state) and a TAB sits on the edge: app glyph + the
 *     app's badge label / count / progress ring. Tap opens it; press-and-hold
 *     lifts it to move it along or onto any edge (lib/edgeBadge.ts).
 *
 * The server (core AppManager) owns the state: every change is a PATCH at the
 * END of a gesture, tagged with this tab's id so its echo is skipped. Other
 * tabs and devices follow via `activity:flightChanged`.
 *
 * Apps talk to their own flight from inside it over postMessage
 * (`aura.flight.*`, see app-sdk flight.ts); the sender is identified by
 * `ev.source`, never by the payload.
 */

import { osEvents } from '../osEvents.ts';
import { runGesture, toLocal, localViewport, rectToLocal, type Edge } from '../keyboard/floatGesture.ts';
import { watchLock } from '../../components/shell/notifications/placement.ts';
import { attachEdgeDrag } from '../edgeBadge.ts';
import { claimFrame, moveInto, parkFrame } from './handoff.ts';
import {
  clampFlightRect, defaultFlightRect, layoutTabs, nearestEdge, perchTarget, posAlong, unfoldRect,
  edgeRect, edgeSizeOf, distanceFromEdge, TEAR_OFF_PX,
  FLIGHT_MIN, EDGE_MIN, type Box, type EdgeSize, type FlightEdge, type Insets, type Size,
} from './geometry.ts';

type Mode = 'free' | 'edge';
type Anchor = { edge: FlightEdge; pos: number };
interface FlightBadge { label?: string; count?: number; progress?: number | null; tint?: string }
interface FlightState {
  mode: Mode;
  modes?: Mode[];
  rect: Box | null;
  size?: Size;
  minSize?: Size;
  anchor: Anchor;
  /** Where the drawer was last docked (edge mode); docking again returns there. */
  edgeAnchor?: Anchor;
  folded: boolean;
  edgeSize: EdgeSize;
  /** Compatibility alias (server-derived): folded ? anchor : null. */
  perch: Anchor | null;
  badge?: FlightBadge;
  actions?: Array<{ id: string; label: string }>;
}

/** Older servers send only `perch` — fill in the mode fields. */
function normalize(f: Partial<FlightState> & { perch?: Anchor | null }): FlightState {
  const anchor = f.anchor ?? f.perch ?? { edge: 'right', pos: 0.5 };
  const folded = typeof f.folded === 'boolean' ? f.folded : !!f.perch;
  return {
    ...f,
    mode: f.mode === 'edge' ? 'edge' : 'free',
    rect: f.rect ?? null,
    anchor,
    folded,
    edgeSize: f.edgeSize ?? { length: 480, depth: 360 },
    perch: folded ? anchor : null,
  } as FlightState;
}
const canUse = (f: FlightView, m: Mode) => !f.flight.modes || f.flight.modes.includes(m);
interface FlightInfo {
  activityId: string; appId: string; parentInstanceId: string; path: string;
  title: string; appName: string; icon?: string; flight: FlightState;
}
interface FlightView extends FlightInfo {
  panel: HTMLElement;
  tab: HTMLButtonElement;
  iframe: HTMLIFrameElement;
  /** Gesture in progress: ignore server echoes for geometry. */
  busy: boolean;
  closing: boolean;
}

const TAB = (() => { try { return crypto.randomUUID(); } catch { return `t${Math.random().toString(36).slice(2)}`; } })();
// Same grips as a Free Window (freeWindow/index.ts): sides + bottom corners.
// No top edge — the header above it is the drag handle.
// Edge mode uses a different set (inner side, ends, inner corners): the grips
// are all rendered and CSS shows the ones of the current mode + edge.
const RESIZE_EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const FREE_GRIPS: Edge[] = ['s', 'e', 'w', 'se', 'sw'];
const EDGE_GRIPS: Record<FlightEdge, Edge[]> = {
  right: ['w', 'n', 's', 'nw', 'sw'],
  left: ['e', 'n', 's', 'ne', 'se'],
  top: ['s', 'w', 'e', 'sw', 'se'],
  bottom: ['n', 'w', 'e', 'nw', 'ne'],
};
/** Grips that change the drawer's LENGTH (along its edge). */
const LENGTH_GRIPS: Record<FlightEdge, string> = { right: 'ns', left: 'ns', top: 'we', bottom: 'we' };

// Inline lucide icons (the shell sprite has none of these).
const svg = (body: string, cls = 'flight-icon') => `<svg class="${cls}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON_LAND = svg('<path d="M2 22h20"/><path d="M3.77 10.77 2 9l2-4.5 1.1.55c.55.28.9.84.9 1.45s.35 1.17.9 1.45L8 8.5l3-6 1.05.53a2 2 0 0 1 1.09 1.52l.72 5.4a2 2 0 0 0 1.09 1.52l4.4 2.2c.42.22.78.55 1.01.96l.6 1.03c.49.88-.06 1.98-1.06 2.1l-1.18.15c-.47.06-.95-.02-1.37-.24L4.29 11.15a2 2 0 0 1-.52-.38Z"/>');
const ICON_DOCK = svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>');            // panel-right
const ICON_FLOAT = svg('<path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4"/><rect width="10" height="7" x="12" y="13" rx="2"/>'); // picture-in-picture-2
const ICON_HIDE = svg('<path d="m9 18 6-6-6-6"/>', 'flight-icon flight-icon-hide');                        // chevron, rotated toward the edge
const CURSOR: Record<Edge, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
};

const flights = new Map<string, FlightView>();
let layer: HTMLElement;
let glow: HTMLElement;
let zTop = 1;

const enc = encodeURIComponent;
const api = (id: string, suffix = '') => `/api/activities/${enc(id)}/flight${suffix}`;

function send(id: string, suffix: string, method: 'PATCH' | 'POST', body?: unknown): Promise<Response | null> {
  return fetch(api(id, suffix), {
    method,
    headers: { 'content-type': 'application/json', 'x-aura-tab': TAB },
    body: JSON.stringify(body ?? {}),
  }).catch(() => null);
}

function iframeUrl(f: FlightInfo): string {
  const p = (f.path || '/').replace(/^\/+/, '');
  return `/api/proxy/${f.parentInstanceId}/${p}?_aura_activity=${enc(f.activityId)}`;
}

function glyphOf(f: FlightInfo): string {
  const g = (f.icon && f.icon.length <= 3 ? f.icon : f.appName.charAt(0)) || '?';
  return g.toUpperCase();
}

function viewport(): Size {
  const v = localViewport();
  return { w: v.width, h: v.height };
}

/** Space the visible bars take — tabs and flights stay clear of them. */
function insets(): Insets {
  const vp = viewport();
  const vis = (id: string): Box | null => {
    const el = document.getElementById(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const l = rectToLocal(r);
    return { x: l.left, y: l.top, w: l.width, h: l.height };
  };
  const top = vis('statusbar');
  const dock = vis('dock');
  return {
    top: top && top.y + top.h > 0 ? Math.max(0, Math.round(top.y + top.h)) : 0,
    bottom: dock && dock.y < vp.h ? Math.max(0, Math.round(vp.h - dock.y)) : 0,
  };
}

function minOf(f: FlightView): Size {
  return f.flight.minSize ?? FLIGHT_MIN;
}

// ─── Render ──────────────────────────────────────────────────────────────

function build(info: FlightInfo): FlightView {
  const panel = document.createElement('section');
  panel.className = 'flight';
  panel.dataset['activityId'] = info.activityId;
  panel.dataset['appId'] = info.appId;
  panel.setAttribute('role', 'dialog');
  panel.innerHTML = `
    <header class="flight-head">
      <span class="flight-glyph" aria-hidden="true"></span>
      <span class="flight-title"></span>
      <span class="flight-closing" hidden>closing…</span>
      <button type="button" class="flight-btn" data-act="hide" data-for="edge" title="Hide into its tab" aria-label="Hide">${ICON_HIDE}</button>
      <button type="button" class="flight-btn" data-act="perch" data-for="free" title="Fold into its tab" aria-label="Fold into its tab">${ICON_HIDE}</button>
      <button type="button" class="flight-btn" data-act="dock" data-for="free" title="Dock back to its edge (drawer)" aria-label="Dock back to its edge">${ICON_DOCK}</button>
      <button type="button" class="flight-btn" data-act="float" data-for="edge" title="Float freely" aria-label="Float freely">${ICON_FLOAT}</button>
      <button type="button" class="flight-btn" data-act="land" title="Pop in — back into the workspace as a window" aria-label="Pop in as a window">${ICON_LAND}</button>
      <button type="button" class="flight-btn flight-btn-close" data-act="close" title="Close" aria-label="Close">✕</button>
    </header>
    <div class="flight-body"></div>
    ${RESIZE_EDGES.map((e) => `<div class="flight-resize" data-edge="${e}"></div>`).join('')}`;
  layer.append(panel);
  const body = panel.querySelector('.flight-body')!;
  // A window that just took off hands over its live iframe (no reload).
  let iframe = claimFrame(info.activityId);
  if (iframe) {
    iframe.removeAttribute('style');
    if (iframe.dataset['src'] && !iframe.getAttribute('src')) { iframe.src = iframe.dataset['src']; delete iframe.dataset['src']; }
    moveInto(body, iframe);
  } else {
    iframe = document.createElement('iframe');
    iframe.src = iframeUrl(info);
    body.appendChild(iframe);
  }
  iframe.className = 'flight-frame';
  iframe.title = info.title;

  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'flight-tab';
  tab.dataset['activityId'] = info.activityId;
  tab.innerHTML = `<span class="flight-tab-ring" aria-hidden="true"></span><span class="flight-tab-glyph"></span><span class="flight-tab-label"></span><span class="flight-tab-count" hidden></span>`;

  layer.append(tab);
  const f: FlightView = { ...info, flight: normalize(info.flight), panel, tab, iframe, busy: false, closing: false };
  wire(f);
  return f;
}

function paint(f: FlightView): void {
  const vp = viewport();
  const ins = insets();
  const glyph = glyphOf(f);
  f.panel.querySelector<HTMLElement>('.flight-glyph')!.textContent = glyph;
  f.panel.querySelector<HTMLElement>('.flight-title')!.textContent = f.title;
  f.panel.setAttribute('aria-label', `${f.appName} flight: ${f.title}`);
  f.panel.querySelector<HTMLElement>('.flight-closing')!.hidden = !f.closing;
  f.panel.classList.toggle('is-closing', f.closing);

  const { mode, folded, anchor } = f.flight;
  f.panel.dataset['mode'] = mode;
  f.panel.dataset['edge'] = anchor.edge;
  f.panel.classList.toggle('is-perched', folded);
  f.panel.setAttribute('aria-hidden', String(folded));
  // Buttons of the other mode, and mode switches the app doesn't allow, stay hidden.
  for (const b of f.panel.querySelectorAll<HTMLElement>('.flight-head [data-for]')) b.hidden = b.dataset['for'] !== mode;
  (f.panel.querySelector('[data-act="dock"]') as HTMLElement).hidden ||= !canUse(f, 'edge');
  (f.panel.querySelector('[data-act="float"]') as HTMLElement).hidden ||= !canUse(f, 'free');
  const grips = mode === 'edge' ? EDGE_GRIPS[anchor.edge] : FREE_GRIPS;
  for (const g of f.panel.querySelectorAll<HTMLElement>('.flight-resize')) g.hidden = !grips.includes(g.dataset['edge'] as Edge);
  // The tab only while folded (an open drawer is its own handle).
  f.tab.hidden = !folded;
  f.panel.querySelector<HTMLElement>('.flight-head')!.title = mode === 'edge' && !folded ? 'Click to hide · drag to move' : '';
  if (!folded && mode === 'free') {
    const r = f.flight.rect
      ? clampFlightRect(f.flight.rect, vp.w, vp.h, minOf(f), ins)
      : defaultFlightRect(f.flight.size, vp.w, vp.h, indexOf(f), minOf(f));
    if (!f.flight.rect) f.flight.rect = r; // placed once; persisted on the next gesture
    place(f.panel, r);
  } else if (!folded && mode === 'edge' && !f.busy) {
    place(f.panel, edgeRect(anchor, f.flight.edgeSize, vp.w, vp.h, ins));
  }
  const tint = f.flight.badge?.tint;
  if (tint) f.panel.style.setProperty('--flight-tint', tint); else f.panel.style.removeProperty('--flight-tint');

  const b = f.flight.badge ?? {};
  f.tab.querySelector<HTMLElement>('.flight-tab-glyph')!.textContent = glyph;
  const label = f.tab.querySelector<HTMLElement>('.flight-tab-label')!;
  label.textContent = b.label ?? '';
  label.hidden = !b.label;
  const count = f.tab.querySelector<HTMLElement>('.flight-tab-count')!;
  count.textContent = b.count ? String(b.count > 99 ? '99+' : b.count) : '';
  count.hidden = !b.count;
  f.tab.style.setProperty('--flight-progress', typeof b.progress === 'number' ? String(b.progress) : '');
  f.tab.classList.toggle('has-progress', typeof b.progress === 'number');
  if (b.tint) f.tab.style.setProperty('--flight-tint', b.tint); else f.tab.style.removeProperty('--flight-tint');
  const tip = `${f.appName}${f.title && f.title !== f.appName ? ` — ${f.title}` : ''}${b.label ? ` · ${b.label}` : ''}`;
  f.tab.title = `${tip}\nTap to open · hold to move`;
  f.tab.setAttribute('aria-label', `Open ${tip}`);
}

function indexOf(f: FlightView): number {
  return [...flights.values()].indexOf(f);
}

function place(el: HTMLElement, r: Box): void {
  el.style.left = `${r.x}px`;
  el.style.top = `${r.y}px`;
  el.style.width = `${r.w}px`;
  el.style.height = `${r.h}px`;
}

/** Lay out all perched tabs (they stack per edge). */
function paintTabs(): void {
  const vp = viewport();
  const folded = [...flights.values()].filter((f) => f.flight.folded && !f.tab.classList.contains('is-lifted'));
  const boxes = layoutTabs(folded.map((f) => ({ id: f.activityId, edge: f.flight.anchor.edge, pos: f.flight.anchor.pos })), vp.w, vp.h, insets());
  for (const f of folded) {
    const box = boxes.get(f.activityId);
    if (!box) continue;
    f.tab.dataset['edge'] = f.flight.anchor.edge;
    place(f.tab, box);
  }
}

function paintAll(): void {
  for (const f of flights.values()) paint(f);
  paintTabs();
}

function raise(f: FlightView): void {
  f.panel.style.zIndex = String(++zTop);
}

// ─── Gestures ────────────────────────────────────────────────────────────

function showGlow(edge: FlightEdge | null): void {
  if (!edge) { glow.hidden = true; return; }
  glow.hidden = false;
  glow.dataset['edge'] = edge;
}

/** Apply a local change, repaint, and persist it (the server echo is ours). */
function commit(f: FlightView, patch: Partial<FlightState>): void {
  Object.assign(f.flight, patch);
  if (f.flight.mode === 'edge') f.flight.edgeAnchor = { ...f.flight.anchor }; // mirrors the server
  f.flight.perch = f.flight.folded ? { ...f.flight.anchor } : null;
  paint(f);
  paintTabs();
  void send(f.activityId, '', 'PATCH', patch);
}

/** Fold into the tab at `p` (both modes). */
function perch(f: FlightView, p: Anchor): void {
  commit(f, { anchor: p, folded: true, ...(f.flight.mode === 'free' && f.flight.rect ? { rect: f.flight.rect } : {}) });
}

/** Open from the tab: the free panel where it was, or the edge drawer at the tab. */
function unfold(f: FlightView): void {
  if (f.flight.mode === 'free') {
    const vp = viewport();
    const tabBox = f.tab.hidden ? null : { x: f.tab.offsetLeft, y: f.tab.offsetTop, w: f.tab.offsetWidth, h: f.tab.offsetHeight };
    commit(f, { folded: false, rect: unfoldRect(f.flight.rect, tabBox, f.flight.size, vp.w, vp.h, minOf(f)) });
  } else {
    commit(f, { folded: false });
  }
  raise(f);
  try { f.iframe.focus(); } catch { /* cross-origin */ }
}

/**
 * Free → edge drawer, where its badge (tab) was put last — in either mode
 * (the flight's `anchor`). Sent explicitly, so the server never guesses.
 */
function dock(f: FlightView, at?: Anchor): void {
  if (!canUse(f, 'edge')) return;
  commit(f, { mode: 'edge', anchor: { ...(at ?? f.flight.anchor) }, folded: false });
  raise(f);
}

/** Edge drawer → free panel, at `rect` (default: where the drawer is now). */
function float(f: FlightView, rect?: Box): void {
  if (!canUse(f, 'free')) return;
  const vp = viewport();
  const base = rect ?? edgeRect(f.flight.anchor, f.flight.edgeSize, vp.w, vp.h, insets());
  commit(f, { mode: 'free', folded: false, rect: clampFlightRect(base, vp.w, vp.h, minOf(f), insets()) });
  raise(f);
}

function wire(f: FlightView): void {
  const head = f.panel.querySelector<HTMLElement>('.flight-head')!;

  f.panel.addEventListener('pointerdown', () => raise(f), true);

  head.addEventListener('pointerdown', (ev) => {
    if ((ev.target as HTMLElement).closest('button')) return;
    if (f.flight.mode === 'edge') { dragDrawer(f, head, ev); return; }
    const start = { ...(f.flight.rect ?? defaultFlightRect(f.flight.size, viewport().w, viewport().h)) };
    let target: { edge: FlightEdge; pos: number } | null = null;
    f.busy = true;
    runGesture(head, ev, (dx, dy) => {
      const vp = viewport();
      f.flight.rect = clampFlightRect({ ...start, x: start.x + dx, y: start.y + dy }, vp.w, vp.h, minOf(f), insets());
      place(f.panel, f.flight.rect);
      const p = toLocal(ev.clientX, ev.clientY);
      target = perchTarget(p.x + dx, p.y + dy, vp.w, vp.h);
      showGlow(target?.edge ?? null);
      f.panel.classList.toggle('is-perch-target', !!target);
    }, (moved) => {
      f.busy = false;
      showGlow(null);
      f.panel.classList.remove('is-perch-target');
      if (!moved) return;
      // Perching keeps the rect the flight had BEFORE it was dragged to the edge.
      if (target) { f.flight.rect = start; perch(f, target); }
      else void send(f.activityId, '', 'PATCH', { rect: f.flight.rect });
    }, { threshold: 4, cursor: 'grabbing' });
  });
  head.addEventListener('dblclick', (ev) => {
    if ((ev.target as HTMLElement).closest('button')) return;
    if (f.flight.mode === 'free') perchNearest(f); // edge mode: a single click already hides it
  });

  for (const handle of f.panel.querySelectorAll<HTMLElement>('.flight-resize')) {
    const edge = handle.dataset['edge'] as Edge;
    handle.addEventListener('pointerdown', (ev) => {
      if (f.flight.mode === 'edge') { resizeDrawer(f, handle, edge, ev); return; }
      const start = { ...(f.flight.rect ?? defaultFlightRect(f.flight.size, viewport().w, viewport().h)) };
      f.busy = true;
      runGesture(handle, ev, (dx, dy) => {
        const vp = viewport();
        f.flight.rect = resizeBox(start, edge, dx, dy, vp, minOf(f));
        place(f.panel, f.flight.rect);
      }, (moved) => {
        f.busy = false;
        if (moved) void send(f.activityId, '', 'PATCH', { rect: f.flight.rect });
      }, { cursor: CURSOR[edge] });
    });
  }

  f.panel.querySelector('[data-act="perch"]')!.addEventListener('click', () => perchNearest(f));
  f.panel.querySelector('[data-act="hide"]')!.addEventListener('click', () => commit(f, { folded: true }));
  f.panel.querySelector('[data-act="dock"]')!.addEventListener('click', () => dock(f));
  f.panel.querySelector('[data-act="float"]')!.addEventListener('click', () => float(f));
  f.panel.querySelector('[data-act="land"]')!.addEventListener('click', () => { void send(f.activityId, '/land', 'POST'); });
  f.panel.querySelector('[data-act="close"]')!.addEventListener('click', () => { void send(f.activityId, '/close', 'POST', { reason: 'user' }); });

  attachEdgeDrag(f.tab, {
    onTap: () => { if (f.flight.folded) unfold(f); },
    onLift: () => { f.busy = true; },
    onDrag: (x, y) => {
      const vp = viewport();
      const n = nearestEdge(x, y, vp.w, vp.h);
      // Follow the pointer, glued to the nearest edge.
      const w = f.tab.offsetWidth || 38, h = f.tab.offsetHeight || 56;
      f.tab.dataset['edge'] = n.edge;
      const left = n.edge === 'left' ? 0 : n.edge === 'right' ? vp.w - w : Math.min(Math.max(0, x - w / 2), vp.w - w);
      const top = n.edge === 'top' ? insets().top : n.edge === 'bottom' ? vp.h - insets().bottom - h : Math.min(Math.max(0, y - h / 2), vp.h - h);
      f.tab.style.left = `${left}px`;
      f.tab.style.top = `${top}px`;
    },
    onDrop: (x, y) => {
      f.busy = false;
      const vp = viewport();
      const n = nearestEdge(x, y, vp.w, vp.h);
      perch(f, { edge: n.edge, pos: posAlong(n.edge, x, y, vp.w, vp.h) });
    },
  });
}

/** The anchor a flight gets when nobody has placed its tab yet (core default). */
const isDefaultAnchor = (a: Anchor) => a.edge === 'right' && a.pos === 0.5;

/**
 * The fold button: into the tab at its saved place (where the badge was put
 * last). Only a flight whose tab was never placed folds onto the edge
 * nearest to the panel.
 */
function perchNearest(f: FlightView): void {
  if (f.flight.mode === 'edge' || !isDefaultAnchor(f.flight.anchor)) { perch(f, f.flight.anchor); return; }
  const r = f.flight.rect;
  const vp = viewport();
  perch(f, r ? nearestEdge(r.x + r.w / 2, r.y + r.h / 2, vp.w, vp.h) : f.flight.anchor);
}

/** Edge mode: how close (px) the pointer must come to ANOTHER edge to slide onto it. */
const EDGE_SWITCH_PX = 56;
/** A loose drawer docks again when one of its sides comes this close (px) to a screen edge. */
const REDOCK_PX = 24;

/**
 * Edge mode: the title bar. A click (no drag) hides the drawer. A drag keeps
 * it DOCKED and slides it along its edge — and round the corners onto the
 * other edges, like the tab — until the pointer is really pulled away
 * (TEAR_OFF_PX further from the edge than where it was grabbed). Then it comes
 * loose and follows the pointer, searching the edges again: as soon as one of
 * its sides comes within REDOCK_PX of a screen edge, it docks there. Released
 * docked: it stays on that edge at that place. Released loose: a free flight
 * (an edge-only app goes back where it was).
 */
function dragDrawer(f: FlightView, head: HTMLElement, ev: PointerEvent): void {
  const vp0 = viewport();
  const start = edgeRect(f.flight.anchor, f.flight.edgeSize, vp0.w, vp0.h, insets());
  const p0 = toLocal(ev.clientX, ev.clientY);
  const side = (e: FlightEdge) => e === 'left' || e === 'right';
  const along = (e: FlightEdge, x: number, y: number) => (side(e) ? y : x);
  // Docked: on `edge`; `base` = the pointer's distance from it when docking,
  // `off` = keeps the drawer from jumping under the pointer along the edge.
  let dock: { edge: FlightEdge; base: number; off: number } | null = {
    edge: f.flight.anchor.edge,
    base: distanceFromEdge(f.flight.anchor.edge, p0.x, p0.y, vp0.w, vp0.h),
    off: (side(f.flight.anchor.edge) ? start.y + start.h / 2 : start.x + start.w / 2) - along(f.flight.anchor.edge, p0.x, p0.y),
  };
  const grab = { x: Math.min(p0.x - start.x, start.w - 40), y: 14 };
  let anchor = f.flight.anchor;
  let box = start;
  f.busy = true;
  runGesture(head, ev, (dx, dy) => {
    const vp = viewport();
    const px = p0.x + dx, py = p0.y + dy;
    const near = nearestEdge(px, py, vp.w, vp.h);
    const nearDist = distanceFromEdge(near.edge, px, py, vp.w, vp.h);
    if (dock) {
      if (distanceFromEdge(dock.edge, px, py, vp.w, vp.h) > dock.base + TEAR_OFF_PX) dock = null;           // pulled away
      else if (near.edge !== dock.edge && nearDist <= EDGE_SWITCH_PX) dock = { edge: near.edge, base: nearDist, off: 0 }; // round the corner
    } else {
      // Loose: search the edges with the drawer itself (not the pointer — that
      // sits on the title bar, far inside it).
      const raw = { x: px - grab.x, y: py - grab.y, w: box.w, h: box.h };
      const gaps: Record<FlightEdge, number> = { left: raw.x, right: vp.w - (raw.x + raw.w), top: raw.y - insets().top, bottom: vp.h - insets().bottom - (raw.y + raw.h) };
      const e = (Object.keys(gaps) as FlightEdge[]).reduce((a, b) => (gaps[b] < gaps[a] ? b : a));
      if (gaps[e] <= REDOCK_PX) {
        const center = side(e) ? raw.y + raw.h / 2 : raw.x + raw.w / 2;
        dock = { edge: e, base: distanceFromEdge(e, px, py, vp.w, vp.h), off: center - along(e, px, py) };   // back onto an edge
      }
    }
    f.panel.classList.toggle('is-tearing', !dock);
    if (dock) {
      const len = side(dock.edge) ? vp.h : vp.w;
      anchor = { edge: dock.edge, pos: Math.min(1, Math.max(0, (along(dock.edge, px, py) + dock.off) / len)) };
      f.panel.dataset['edge'] = anchor.edge;
      box = edgeRect(anchor, f.flight.edgeSize, vp.w, vp.h, insets());
    } else {
      box = clampFlightRect({ x: px - grab.x, y: py - grab.y, w: box.w, h: box.h }, vp.w, vp.h, minOf(f), insets());
    }
    place(f.panel, box);
  }, (moved) => {
    f.busy = false;
    f.panel.classList.remove('is-tearing');
    if (!moved) { commit(f, { folded: true }); return; } // a click: hide
    if (dock) commit(f, { anchor, folded: false });
    else if (canUse(f, 'free')) float(f, box);
    else commit(f, { anchor: f.flight.anchor }); // edge-only: back where it was
  }, { threshold: 4, cursor: 'grabbing' });
}

/** Edge mode: resize from the inner side (depth) and the ends (length). */
function resizeDrawer(f: FlightView, handle: HTMLElement, grip: Edge, ev: PointerEvent): void {
  const vp0 = viewport();
  const { edge } = f.flight.anchor;
  const start = edgeRect(f.flight.anchor, f.flight.edgeSize, vp0.w, vp0.h, insets());
  const wasFull = f.flight.edgeSize.length === 'full';
  const lengthChanged = [...grip].some((c) => LENGTH_GRIPS[edge].includes(c));
  const min = { w: EDGE_MIN, h: EDGE_MIN };
  let box = start;
  f.busy = true;
  runGesture(handle, ev, (dx, dy) => {
    const vp = viewport();
    box = resizeBox(start, grip, dx, dy, vp, min);
    place(f.panel, box);
  }, (moved) => {
    f.busy = false;
    if (!moved) return;
    const vp = viewport();
    const { size, pos } = edgeSizeOf(box, edge, vp.w, vp.h, wasFull, lengthChanged);
    commit(f, { edgeSize: size, anchor: { edge, pos: lengthChanged ? pos : f.flight.anchor.pos } });
  }, { cursor: CURSOR[grip] });
}

function resizeBox(start: Box, edge: Edge, dx: number, dy: number, vp: Size, min: Size): Box {
  let { x, y, w, h } = start;
  const right = start.x + start.w, bottom = start.y + start.h;
  if (edge.includes('e')) w = Math.min(Math.max(min.w, start.w + dx), vp.w - start.x);
  if (edge.includes('s')) h = Math.min(Math.max(min.h, start.h + dy), vp.h - start.y);
  if (edge.includes('w')) { x = Math.min(Math.max(0, start.x + dx), right - min.w); w = right - x; }
  if (edge.includes('n')) { y = Math.min(Math.max(0, start.y + dy), bottom - min.h); h = bottom - y; }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(Math.max(min.w, w)), h: Math.round(Math.max(min.h, h)) };
}

// ─── Server sync ─────────────────────────────────────────────────────────

async function refresh(): Promise<void> {
  const res = await fetch('/api/flights').catch(() => null);
  if (!res?.ok) return;
  const list = await res.json().catch(() => []) as FlightInfo[];
  const seen = new Set<string>();
  for (const info of list) {
    seen.add(info.activityId);
    const have = flights.get(info.activityId);
    if (have) {
      Object.assign(have, { title: info.title, appName: info.appName, icon: info.icon });
      if (!have.busy) have.flight = normalize(info.flight);
    } else {
      const f = build(info);
      flights.set(info.activityId, f);
      raise(f);
    }
  }
  for (const id of [...flights.keys()]) if (!seen.has(id)) drop(id);
  paintAll();
}

/**
 * Remove a flight's panel + tab. `park`: it is landing as a window — hand the
 * live iframe over (lib/flight/handoff.ts) instead of unloading it.
 */
function drop(id: string, park = false): void {
  const f = flights.get(id);
  if (!f) return;
  flights.delete(id);
  if (park) parkFrame(id, f.iframe);
  f.panel.remove();
  f.tab.remove();
  paintTabs();
}

function onEvent(ev: { type: string; [k: string]: unknown }): void {
  const id = ev['activityId'] as string | undefined;
  if (!id) return;
  switch (ev.type) {
    case 'activity:opened':
      if (ev['presentation'] === 'flight') void refresh();
      return;
    case 'activity:closed':
      drop(id);
      return;
    case 'activity:flightChanged': {
      if (ev['presentation'] !== 'flight') { drop(id, ev['change'] === 'land'); return; }
      const f = flights.get(id);
      if (!f || ev['change'] === 'takeoff') { void refresh(); return; }
      if (typeof ev['title'] === 'string') f.title = ev['title'] as string;
      // Our own write coming back, or a gesture in progress: geometry stays ours.
      const own = ev['by'] === TAB || f.busy;
      const raw = ev['flight'] as FlightState | undefined;
      if (raw) {
        const next = normalize(raw);
        const modeChanged = next.mode !== f.flight.mode;
        // Own echo / gesture in progress: keep the local geometry, take the rest.
        f.flight = own ? { ...next, mode: f.flight.mode, rect: f.flight.rect, anchor: f.flight.anchor, edgeAnchor: f.flight.edgeAnchor, folded: f.flight.folded, edgeSize: f.flight.edgeSize, perch: f.flight.perch } : next;
        if (modeChanged && !own) notifyFrame(f, 'aura.flight.mode', { mode: f.flight.mode });
      }
      paint(f);
      paintTabs();
      notifyFrame(f, 'aura.flight.state', { flight: f.flight });
      return;
    }
    case 'activity:flightClosing': {
      const f = flights.get(id);
      if (!f) return;
      f.closing = true;
      paint(f);
      notifyFrame(f, 'aura.flight.closing', { reason: ev['reason'], vetoMs: ev['vetoMs'] });
      return;
    }
    case 'activity:flightKept': {
      const f = flights.get(id);
      if (!f) return;
      f.closing = false;
      paint(f);
      raise(f);
      try { f.iframe.focus(); } catch { /* cross-origin */ }
      return;
    }
    case 'activity:flightAction': {
      const f = flights.get(id);
      if (f) notifyFrame(f, 'aura.flight.action', { actionId: ev['actionId'] });
      return;
    }
  }
}

// ─── App ↔ shell (postMessage) ───────────────────────────────────────────

function notifyFrame(f: FlightView, type: string, payload: Record<string, unknown>): void {
  try { f.iframe.contentWindow?.postMessage({ type, activityId: f.activityId, ...payload }, '*'); } catch { /* gone */ }
}

function flightOfSource(src: MessageEventSource | null): FlightView | null {
  if (!src) return null;
  for (const f of flights.values()) if (f.iframe.contentWindow === src) return f;
  return null;
}

/**
 * Messages from inside a flight (SDK `os.flight.current`): the flight
 * controls itself. Geometry from an app is a request — the shell clamps it.
 */
function onMessage(ev: MessageEvent): void {
  const d = ev.data as { type?: unknown; [k: string]: unknown } | null;
  if (!d || typeof d.type !== 'string' || !d.type.startsWith('aura.flight.')) return;
  const f = flightOfSource(ev.source);
  if (!f) return;
  switch (d.type) {
    case 'aura.flight.hello':
      notifyFrame(f, 'aura.flight.state', { flight: f.flight });
      return;
    case 'aura.flight.perch': {
      const edge = d['edge'] as FlightEdge | undefined;
      if (edge && ['left', 'right', 'top', 'bottom'].includes(edge)) perch(f, { edge, pos: typeof d['pos'] === 'number' ? Math.min(1, Math.max(0, d['pos'] as number)) : 0.5 });
      else perchNearest(f);
      return;
    }
    case 'aura.flight.unfold':
    case 'aura.flight.show':
      if (f.flight.folded) unfold(f);
      return;
    case 'aura.flight.hide':
      if (!f.flight.folded) perch(f, f.flight.anchor);
      return;
    case 'aura.flight.mode':
      if (d['mode'] === 'edge') dock(f); else if (d['mode'] === 'free') float(f);
      return;
    case 'aura.flight.resize': {
      const w = Number(d['w']), h = Number(d['h']);
      if (!Number.isFinite(w) || !Number.isFinite(h)) return;
      const vp = viewport();
      if (f.flight.mode === 'edge') {
        const side = f.flight.anchor.edge === 'left' || f.flight.anchor.edge === 'right';
        commit(f, { edgeSize: { length: side ? h : w, depth: side ? w : h } });
        return;
      }
      const r = f.flight.rect ?? defaultFlightRect(f.flight.size, vp.w, vp.h);
      commit(f, { rect: clampFlightRect({ ...r, w, h }, vp.w, vp.h, minOf(f), insets()) });
      return;
    }
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────

export function initFlightLayer(root: HTMLElement): void {
  if ((window as unknown as { __auraFlightLayer?: boolean }).__auraFlightLayer) return;
  (window as unknown as { __auraFlightLayer?: boolean }).__auraFlightLayer = true;
  layer = root;
  glow = document.createElement('div');
  glow.className = 'flight-perch-glow';
  glow.hidden = true;
  layer.appendChild(glow);

  osEvents.subscribe(['activity:*'], (ev) => onEvent(ev));
  window.addEventListener('message', onMessage);
  let raf = 0;
  window.addEventListener('resize', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paintAll(); }); });
  // The bars appearing / hiding changes the insets the tabs avoid.
  for (const id of ['statusbar', 'dock']) {
    const el = document.getElementById(id);
    if (el && 'ResizeObserver' in window) new ResizeObserver(() => paintTabs()).observe(el);
  }
  new MutationObserver(() => paintTabs()).observe(document.body, { attributes: true, attributeFilter: ['data-show-top', 'data-show-bottom', 'data-autohide-bars'] });
  watchLock((locked) => { layer.hidden = locked; });
  void refresh();
  // Reconnects can miss events: re-read the list when the tab comes back.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh(); });

  (window as unknown as { auraFlights?: unknown }).auraFlights = {
    list: () => [...flights.values()].map((f) => ({ activityId: f.activityId, appId: f.appId, flight: f.flight })),
    refresh,
    /** The desktop is about to show this flight as a window: park its iframe now. */
    release: (id: string) => drop(id, true),
  };
}
