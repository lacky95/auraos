/**
 * Free Window — floating windows with Windows-style docking, built only on
 * the layout SDK (../../types.ts):
 *
 *   • drag by the title bar; resize from the sides, bottom and bottom corners
 *     (never the top — height changes from the bottom only)
 *   • dock zones while dragging — left/right edge → half, corner → quarter,
 *     top edge → whole area — with a live preview; dragging a docked window
 *     out gives it its previous size back under the pointer
 *   • docked windows share one snap grid per workspace: the border between
 *     neighbours is a splitter that resizes all of them together
 *   • `minimize: 'hide'` (every window, app stays alive) + a taskbar in the
 *     content space's top region
 *
 * Persisted per workspace in layoutState:
 *   rects[viewId] = { x, y, w, h, z, snap?: { zone, restore: { w, h } } }
 *   snapGrid      = { x, yl, yr }
 */
import type { LayoutHost, LayoutRegion, LayoutViewInfo, ShellLayoutStrategy } from '../../types.ts';
import { clampRect, defaultRect, resizeRect, type Handle, type Rect, type Size } from './geometry.ts';
import {
  dragSplitter, gridForNewSnap, normalizeGrid, rectForZone, restoreOnDragOut, splittersFor,
  splittersForHandle, zoneAt, ZONES, type SnapGrid, type SplitterKey, type Zone,
} from './snap.ts';
import { createTaskbar } from './taskbar.ts';
import { ensureFreeWindowStyles } from './styles.ts';

interface SavedRect extends Rect {
  z: number;
  snap?: { zone: Zone; restore: { w: number; h: number } };
}

/** Restack once z-indices pass this, so they never climb into the overlay
 *  (800) or maximized (60 → host) ranges forever. */
const Z_RENORMALIZE_AT = 500;
/** Resize handles a window gets. No top edge / top corners: height only
 *  changes from the bottom, so the title bar is always a drag handle. */
const RESIZE_HANDLES: readonly Handle[] = ['s', 'e', 'w', 'se', 'sw'];
/** Pointer travel before a docked window lets go of its dock. */
const UNDOCK_THRESHOLD = 6;

export function createFreeWindow(): ShellLayoutStrategy {
  let host: LayoutHost | null = null;
  let ro: ResizeObserver | null = null;
  /** Slot whose box the pointer currently owns — renders leave it alone. */
  let gestureEl: HTMLElement | null = null;
  let endGesture: (() => void) | null = null;
  /** Live grid during a splitter drag (renders use it instead of the stored one). */
  let liveGrid: SnapGrid | null = null;
  const bound = new WeakMap<HTMLElement, { off: () => void }>();

  // ---- state helpers ------------------------------------------------------
  const H = () => host!;
  const area = (): Size => ({ w: H().container.clientWidth, h: H().container.clientHeight });
  const rects = (): Record<string, SavedRect> =>
    (H().layoutState()['rects'] as Record<string, SavedRect> | undefined) ?? {};
  const grid = (): SnapGrid => liveGrid ?? normalizeGrid(H().layoutState()['snapGrid'] as Partial<SnapGrid> | undefined);
  const zoneOf = (r: SavedRect | undefined): Zone | null =>
    r?.snap && ZONES.includes(r.snap.zone) ? r.snap.zone : null;

  function readRect(el: HTMLElement): Rect {
    return {
      x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0,
      w: parseFloat(el.style.width) || 0, h: parseFloat(el.style.height) || 0,
    };
  }
  function writeRect(el: HTMLElement, r: Rect): void {
    el.style.left = r.x + 'px'; el.style.top = r.y + 'px';
    el.style.width = r.w + 'px'; el.style.height = r.h + 'px';
  }
  function persist(updates: Record<string, SavedRect>, extra: Record<string, unknown> = {}): void {
    H().patchLayoutState({ rects: { ...rects(), ...updates }, ...extra });
  }

  /** Slots of the active workspace that are on screen and placed by us. */
  function placedSlots(): HTMLElement[] {
    return [...H().container.querySelectorAll<HTMLElement>(':scope > .app-slot[data-fw-placed="1"]')]
      .filter((el) => el.style.display !== 'none');
  }
  function dockedZones(exceptViewId?: string): Zone[] {
    const out: Zone[] = [];
    for (const el of placedSlots()) {
      const z = el.dataset['fwZone'] as Zone | undefined;
      if (z && el.dataset['viewId'] !== exceptViewId) out.push(z);
    }
    return out;
  }

  // ---- z-order -------------------------------------------------------------
  function zOf(el: HTMLElement): number { return parseInt(el.style.zIndex, 10) || 10; }
  function frontSlot(): HTMLElement | null {
    let best: HTMLElement | null = null;
    for (const el of placedSlots()) if (!best || zOf(el) > zOf(best)) best = el;
    return best;
  }
  function bringToFront(el: HTMLElement, viewId: string): void {
    const peers = placedSlots().filter((p) => p !== el);
    const maxZ = peers.reduce((m, p) => Math.max(m, zOf(p)), 10);
    if (zOf(el) > maxZ && el.dataset['fwPlaced'] === '1') return; // already on top
    const saved = rects();
    if (maxZ + 1 >= Z_RENORMALIZE_AT) {
      // Restack everyone 10, 11, … in current order, `el` last.
      const order = [...peers].sort((a, b) => zOf(a) - zOf(b));
      const updates: Record<string, SavedRect> = {};
      [...order, el].forEach((p, i) => {
        const id = p.dataset['viewId']!;
        p.style.zIndex = String(10 + i);
        updates[id] = { ...(saved[id] ?? { ...readRect(p) }), z: 10 + i } as SavedRect;
      });
      persist(updates);
      return;
    }
    el.style.zIndex = String(maxZ + 1);
    persist({ [viewId]: { ...(saved[viewId] ?? readRect(el)), z: maxZ + 1 } as SavedRect });
  }

  // ---- gestures --------------------------------------------------------------
  /**
   * One pointer gesture (move / resize / splitter). Pointer capture keeps
   * events flowing over app iframes; `body.aura-stack-dragging` disables
   * iframe hit-testing as a fallback. Moves are coalesced per frame. The
   * gesture always ends — on pointerup/cancel, lost capture, a pointerup
   * anywhere, or the window losing focus — so it can never stay stuck.
   */
  function runGesture(
    el: HTMLElement | null,
    captureEl: HTMLElement,
    ev: PointerEvent,
    onMove: (p: { x: number; y: number }) => void,
    onEnd: (p: { x: number; y: number }) => void,
  ): void {
    ev.preventDefault();
    endGesture?.();
    try { captureEl.setPointerCapture(ev.pointerId); } catch { /* unsupported */ }
    document.body.classList.add('aura-stack-dragging');
    H().setGestureActive(true);
    gestureEl = el;

    let last = H().toLocal(ev.clientX, ev.clientY);
    let pending = false;
    let raf = 0;
    const flush = () => { raf = 0; if (pending) { pending = false; onMove(last); } };
    const move = (mv: PointerEvent) => {
      if (mv.pointerId !== ev.pointerId) return;
      last = H().toLocal(mv.clientX, mv.clientY);
      pending = true;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (raf) cancelAnimationFrame(raf);
      flush();
      captureEl.removeEventListener('pointermove', move);
      captureEl.removeEventListener('pointerup', up);
      captureEl.removeEventListener('pointercancel', up);
      captureEl.removeEventListener('lostpointercapture', up);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', end);
      try { if (captureEl.hasPointerCapture(ev.pointerId)) captureEl.releasePointerCapture(ev.pointerId); } catch { /* gone */ }
      if (endGesture === end) endGesture = null;
      gestureEl = null;
      document.body.classList.remove('aura-stack-dragging');
      try { onEnd(last); } finally {
        H().setGestureActive(false);
        H().broadcastViewport();
      }
    };
    function up(e: PointerEvent) { if (e.pointerId === ev.pointerId) end(); }
    endGesture = end;
    captureEl.addEventListener('pointermove', move);
    captureEl.addEventListener('pointerup', up);
    captureEl.addEventListener('pointercancel', up);
    captureEl.addEventListener('lostpointercapture', up);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', end);
  }

  function startMove(el: HTMLElement, viewId: string, chrome: HTMLElement, ev: PointerEvent): void {
    const saved = rects()[viewId];
    const docked = zoneOf(saved) ? saved!.snap! : null;
    const startP = H().toLocal(ev.clientX, ev.clientY);
    let base = readRect(el);
    let baseP: { x: number; y: number } = startP;
    let free = !docked;
    let zone: Zone | null = null;

    runGesture(el, chrome, ev, (p) => {
      const A = area();
      if (!free) {
        if (Math.hypot(p.x - startP.x, p.y - startP.y) < UNDOCK_THRESHOLD) return;
        base = restoreOnDragOut(readRect(el), docked!.restore, p);
        baseP = p;
        free = true;
        delete el.dataset['fwZone'];
        el.style.width = base.w + 'px';
        el.style.height = base.h + 'px';
      }
      const r = clampRect({ ...base, x: base.x + p.x - baseP.x, y: base.y + p.y - baseP.y }, A);
      el.style.left = r.x + 'px';
      el.style.top = r.y + 'px';
      zone = zoneAt(p.x, p.y, A);
      showPreview(zone ? rectForZone(zone, gridForNewSnap(zone, dockedZones(viewId), grid()), A) : null);
    }, () => {
      showPreview(null);
      if (!free) return; // a click on a docked window's title: nothing moved
      const z = zOf(el);
      const cur = clampRect(readRect(el), area());
      if (zone) {
        const g = gridForNewSnap(zone, dockedZones(viewId), grid());
        const r = rectForZone(zone, g, area());
        writeRect(el, r);
        el.dataset['fwZone'] = zone;
        persist({ [viewId]: { ...r, z, snap: { zone, restore: { w: cur.w, h: cur.h } } } }, { snapGrid: g });
      } else {
        writeRect(el, cur);
        persist({ [viewId]: { ...cur, z } });
      }
    });
  }

  function startResize(el: HTMLElement, viewId: string, handleEl: HTMLElement, handle: Handle, ev: PointerEvent): void {
    ev.stopPropagation();
    const saved = rects()[viewId];
    const zone = zoneOf(saved);
    const keys = zone ? splittersForHandle(zone, handle) : [];
    if (zone && keys.length) {
      // Shared edge of a docked window: move the grid → all neighbours follow.
      startSplitterDrag(keys, handleEl, ev);
      return;
    }
    // Free window, or an outer edge of a docked one (which undocks it).
    if (zone) delete el.dataset['fwZone'];
    const start = readRect(el);
    const startP = H().toLocal(ev.clientX, ev.clientY);
    runGesture(el, handleEl, ev, (p) => {
      writeRect(el, resizeRect(start, handle, p.x - startP.x, p.y - startP.y, area()));
    }, () => {
      const cur = clampRect(readRect(el), area());
      writeRect(el, cur);
      persist({ [viewId]: { ...cur, z: zOf(el) } });
    });
  }

  function startSplitterDrag(keys: SplitterKey[], captureEl: HTMLElement, ev: PointerEvent): void {
    liveGrid = grid();
    runGesture(null, captureEl, ev, (p) => {
      let g = liveGrid!;
      for (const k of keys) g = dragSplitter(g, k, k === 'x' ? p.x : p.y, area());
      liveGrid = g;
      layoutDocked();
      renderSplitters();
    }, () => {
      const g = liveGrid!;
      liveGrid = null;
      // Keep each docked window's stored pixels in step (fallback + windowNav).
      const saved = rects();
      const updates: Record<string, SavedRect> = {};
      for (const el of placedSlots()) {
        const id = el.dataset['viewId']!;
        const z = el.dataset['fwZone'] as Zone | undefined;
        if (z && saved[id]?.snap) updates[id] = { ...saved[id]!, ...rectForZone(z, g, area()) };
      }
      persist(updates, { snapGrid: g });
    });
  }

  // ---- per-slot handlers -----------------------------------------------------
  function bind(el: HTMLElement, viewId: string): void {
    if (bound.has(el)) return;
    el.dataset['stackHandlersBound'] = '1'; // shared CSS hooks (grab cursor)
    const chrome = el.querySelector<HTMLElement>('.slot-chrome');
    const onChromeDown = (ev: PointerEvent) => {
      if ((ev.target as HTMLElement | null)?.closest('button, input, textarea, select')) return;
      if (ev.button !== 0) return;
      bringToFront(el, viewId);
      startMove(el, viewId, chrome!, ev);
    };
    if (chrome) {
      chrome.style.touchAction = 'none';
      chrome.addEventListener('pointerdown', onChromeDown);
    }
    const handles: HTMLElement[] = [];
    for (const h of RESIZE_HANDLES) {
      const d = document.createElement('div');
      d.className = 'fw-resize';
      d.dataset['handle'] = h;
      d.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        bringToFront(el, viewId);
        startResize(el, viewId, d, h, ev);
      });
      el.appendChild(d);
      handles.push(d);
    }
    const onAnyDown = () => bringToFront(el, viewId);
    el.addEventListener('pointerdown', onAnyDown);
    bound.set(el, {
      off: () => {
        if (chrome) {
          chrome.removeEventListener('pointerdown', onChromeDown);
          chrome.style.removeProperty('touch-action');
        }
        el.removeEventListener('pointerdown', onAnyDown);
        for (const d of handles) d.remove();
        delete el.dataset['stackHandlersBound'];
      },
    });
  }

  // ---- overlay: preview + splitters -------------------------------------------
  let preview: HTMLElement | null = null;
  function showPreview(r: Rect | null): void {
    if (!r) { if (preview) preview.dataset['on'] = '0'; return; }
    if (!preview) {
      preview = document.createElement('div');
      preview.className = 'fw-snap-preview';
      H().overlay().appendChild(preview);
    }
    writeRect(preview, r);
    preview.dataset['on'] = '1';
  }

  const splitterEls = new Map<SplitterKey, HTMLElement>();
  function renderSplitters(): void {
    const hide = H().maximizedViewId() !== null;
    const list = hide ? [] : splittersFor(dockedZones(), grid(), area());
    const want = new Set(list.map((s) => s.key));
    for (const [k, node] of splitterEls) if (!want.has(k)) { node.remove(); splitterEls.delete(k); }
    for (const s of list) {
      let node = splitterEls.get(s.key);
      if (!node) {
        node = document.createElement('div');
        node.className = 'fw-splitter';
        node.dataset['axis'] = s.key === 'x' ? 'v' : 'h';
        const key = s.key;
        node.addEventListener('pointerdown', (ev) => { if (ev.button === 0) startSplitterDrag([key], node!, ev); });
        H().overlay().appendChild(node);
        splitterEls.set(s.key, node);
      }
      writeRect(node, s.rect);
    }
  }

  /** Re-apply every docked window's rect from the (live) grid. */
  function layoutDocked(): void {
    const g = grid();
    const A = area();
    for (const el of placedSlots()) {
      const z = el.dataset['fwZone'] as Zone | undefined;
      if (z) writeRect(el, rectForZone(z, g, A));
    }
  }

  /** Viewport/area changed: docked windows follow the grid, free ones are
   *  re-clamped so none ends up unreachable. */
  function reflow(): void {
    if (!host) return;
    const A = area();
    if (A.w <= 0 || A.h <= 0) return;
    layoutDocked();
    const saved = rects();
    const updates: Record<string, SavedRect> = {};
    for (const el of placedSlots()) {
      if (el === gestureEl || el.dataset['fwZone']) continue;
      const before = readRect(el);
      const after = clampRect(before, A);
      if (after.x !== before.x || after.y !== before.y || after.w !== before.w || after.h !== before.h) {
        writeRect(el, after);
        const id = el.dataset['viewId']!;
        updates[id] = { ...(saved[id] ?? { z: zOf(el) }), ...after } as SavedRect;
      }
    }
    if (Object.keys(updates).length) persist(updates);
    renderSplitters();
  }

  // ---- taskbar ----------------------------------------------------------------
  const taskbar: LayoutRegion = createTaskbar({
    isFront: (viewId) => frontSlot()?.dataset['viewId'] === viewId,
    activate: (viewId) => {
      const v = H().views().find((x) => x.viewId === viewId);
      if (!v) return;
      if (v.minimized) { H().restore(viewId); return; } // restore raises via onActivate
      const el = H().slotOf(viewId);
      if (el && frontSlot() === el) { H().minimize(viewId); return; }
      if (el) bringToFront(el, viewId);
      H().focus(viewId);
    },
  });

  return {
    id: 'stack',
    minimize: 'hide',
    showsMinimizedStrip: false,
    // Free Window moves windows itself — no swap-on-drop between slots.
    dragPolicy: { enabled: false },
    regions: { top: taskbar },

    activate(h) {
      host = h;
      ensureFreeWindowStyles();
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => reflow());
        ro.observe(h.container);
      }
    },
    deactivate() {
      endGesture?.();
      ro?.disconnect(); ro = null;
      preview?.remove(); preview = null;
      for (const n of splitterEls.values()) n.remove();
      splitterEls.clear();
      host = null;
    },

    containerStyle() {
      return {
        display: 'block',
        gridTemplateColumns: '', gridTemplateRows: '', gap: '',
        background: 'var(--aura-color-bg)',
        alignItems: '', justifyContent: '', flexDirection: '',
      };
    },

    place(el: HTMLElement, v: LayoutViewInfo, index: number) {
      el.dataset['viewId'] = v.viewId;
      el.style.position = 'absolute';
      el.style.removeProperty('grid-column');
      el.style.removeProperty('grid-row');
      bind(el, v.viewId);
      const wasPlaced = el.dataset['fwPlaced'] === '1';
      el.dataset['fwPlaced'] = '1';
      // The pointer owns this box right now — a render (our own persist, the
      // server echo) must not snap it back to the stored rect mid-gesture.
      if (el === gestureEl && wasPlaced) return;
      const saved = rects()[v.viewId];
      const A = area();
      const zone = zoneOf(saved);
      if (zone) {
        el.dataset['fwZone'] = zone;
        writeRect(el, rectForZone(zone, grid(), A));
      } else {
        delete el.dataset['fwZone'];
        writeRect(el, clampRect(saved ?? defaultRect(index, A), A));
      }
      el.style.zIndex = String(saved?.z ?? 10 + index);
    },

    release(el) {
      bound.get(el)?.off();
      bound.delete(el);
      if (el === gestureEl) endGesture?.();
      delete el.dataset['fwPlaced'];
      delete el.dataset['fwZone'];
      for (const p of ['position', 'left', 'top', 'width', 'height', 'z-index']) el.style.removeProperty(p);
    },

    afterRender() { renderSplitters(); },

    onActivate(viewId) {
      const el = H().slotOf(viewId);
      if (el && el.dataset['fwPlaced'] === '1') bringToFront(el, viewId);
    },
  };
}
