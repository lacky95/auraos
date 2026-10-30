/**
 * Generic window drag & drop for the shell.
 *
 * Dragging a slot's title bar shows a small fixed-size "mini window" ghost
 * (border + window name) under the cursor instead of moving the real window.
 * What a drop DOES is pluggable:
 *   • drop targets (workspace pills, other slots, …) register themselves via
 *     `registerDropTarget()` and decide via `resolve()` whether the element
 *     under the pointer accepts the drag;
 *   • the active layout strategy installs a `LayoutDragPolicy` via
 *     `setLayoutDragPolicy()` — `enabled:false` turns the whole feature off
 *     (Free Window has its own move/resize drag), and `slotDrop` says what
 *     dropping onto another window means (e.g. swap) — absent = not allowed.
 */

export interface DragSource {
  viewId: string;
  title: string;
}

export interface LayoutDragPolicy {
  enabled: boolean;
  /** Drop onto another window of the same workspace. Absent = disallowed. */
  slotDrop?: (src: DragSource, targetViewId: string) => void | Promise<void>;
}

export interface DropMatch {
  el: HTMLElement;
  data: unknown;
}

export interface WindowDropTarget {
  id: string;
  /** Return a match if `el` (the element under the pointer) accepts `src`. */
  resolve(el: Element, src: DragSource): DropMatch | null;
  drop(src: DragSource, data: unknown): void | Promise<void>;
  /** Optional hover feedback hooks (e.g. dwell-to-open a dropdown). */
  enter?(match: DropMatch, src: DragSource): void;
  leave?(match: DropMatch, src: DragSource): void;
}

const DRAG_THRESHOLD_PX = 5;
const GHOST_OFFSET_PX = 4;

const targets: WindowDropTarget[] = [];
let policy: LayoutDragPolicy | null = null;
let dragging = false;

export function registerDropTarget(t: WindowDropTarget): () => void {
  targets.push(t);
  return () => {
    const i = targets.indexOf(t);
    if (i >= 0) targets.splice(i, 1);
  };
}

export function setLayoutDragPolicy(p: LayoutDragPolicy | null): void {
  policy = p;
}

export function getLayoutDragPolicy(): LayoutDragPolicy | null {
  return policy;
}

export function isWindowDragging(): boolean {
  return dragging;
}

interface GhostSessionOptions {
  /** Ghost already visible at the first event (hand-off); no threshold. */
  immediate: boolean;
  /** Element holding pointer capture for the drag, if any. */
  handle: HTMLElement | null;
  shouldReturn?(e: PointerEvent): boolean;
  onReturn?(e: PointerEvent): void;
  onEnd?(result: { dropped: boolean }): void;
}

/** One ghost drag: threshold (unless immediate), ghost, drop-target hover,
 *  drop or cancel. Shared by `beginWindowDrag` and `handOffActivityDrag`. */
function runGhostSession(ev: PointerEvent, src: DragSource, sourceEl: HTMLElement, opts: GhostSessionOptions): void {
  const { handle } = opts;
  const startX = ev.clientX;
  const startY = ev.clientY;
  const pointerId = ev.pointerId;
  let started = false;
  let ghost: HTMLElement | null = null;
  let current: { target: WindowDropTarget; match: DropMatch } | null = null;

  const setCurrent = (next: typeof current) => {
    if (current && next && current.target === next.target && current.match.el === next.match.el) return;
    if (current) {
      current.match.el.removeAttribute('data-drop-hover');
      current.target.leave?.(current.match, src);
    }
    current = next;
    if (current) {
      current.match.el.setAttribute('data-drop-hover', 'true');
      current.target.enter?.(current.match, src);
    }
  };

  const start = () => {
    started = true;
    dragging = true;
    try { handle?.setPointerCapture(pointerId); } catch { /* not capturable */ }
    document.body.classList.add('aura-window-dragging');
    sourceEl.setAttribute('data-drag-source', 'true');
    ghost = document.createElement('div');
    ghost.className = 'aura-drag-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    const bar = document.createElement('div');
    bar.className = 'aura-drag-ghost-title';
    bar.textContent = src.title;
    ghost.appendChild(bar);
    document.body.appendChild(ghost);
  };

  const track = (e: PointerEvent) => {
    // The shell zooms via `body { transform: scale(...) }` plus margins, and a
    // transformed ancestor makes `position:fixed` relative to <body> in its
    // own (unscaled) units — so map viewport coords into body coords.
    const body = document.body;
    const r = body.getBoundingClientRect();
    const scale = body.offsetWidth ? r.width / body.offsetWidth : 1;
    const x = (e.clientX - r.left) / scale + GHOST_OFFSET_PX;
    const y = (e.clientY - r.top) / scale + GHOST_OFFSET_PX;
    ghost!.style.transform = `translate(${x}px, ${y}px)`;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    let next: typeof current = null;
    if (under) {
      for (const t of targets) {
        const m = t.resolve(under, src);
        if (m) { next = { target: t, match: m }; break; }
      }
    }
    setCurrent(next);
  };

  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    if (!started) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD_PX) return;
      start();
    }
    e.preventDefault();
    if (opts.shouldReturn?.(e)) {
      // Back to the caller's own drag: tear the ghost down, pointer still down.
      teardown();
      opts.onReturn?.(e);
      return;
    }
    track(e);
  };

  const removeListeners = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('keydown', key, true);
  };
  /** Ghost + hover state off; listeners off. Returns the hovered target. */
  const teardown = () => {
    removeListeners();
    const hit = current;
    setCurrent(null);
    ghost?.remove();
    ghost = null;
    sourceEl.removeAttribute('data-drag-source');
    document.body.classList.remove('aura-window-dragging');
    dragging = false;
    return hit;
  };

  const finish = (commit: boolean) => {
    if (!started) { removeListeners(); return; }
    const hit = teardown();
    try { handle?.releasePointerCapture(pointerId); } catch { /* already released */ }
    // Swallow the click that follows a real drag so title-bar handlers don't fire.
    // The click (if any) is dispatched right after pointerup, so a 0ms
    // timeout removes the swallower before any later, genuine click.
    const swallow = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); };
    window.addEventListener('click', swallow, true);
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    const dropped = commit && !!hit;
    if (dropped) {
      Promise.resolve(hit!.target.drop(src, hit!.match.data)).catch((err) =>
        console.warn('[windowDrag] drop failed', err));
    }
    opts.onEnd?.({ dropped });
  };
  const up = (e: PointerEvent) => { if (e.pointerId === pointerId) finish(true); };
  const cancel = (e: PointerEvent) => { if (e.pointerId === pointerId) finish(false); };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && started) { e.preventDefault(); e.stopPropagation(); finish(false); }
  };

  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cancel, true);
  window.addEventListener('keydown', key, true);
  if (opts.immediate) {
    start();
    track(ev);
  }
}

/**
 * Arm a potential drag from a title-bar `pointerdown`. Nothing visible
 * happens until the pointer travels past the threshold, so clicks and
 * double-click rename keep working.
 */
export function beginWindowDrag(ev: PointerEvent, src: DragSource, sourceEl: HTMLElement): void {
  if (!policy?.enabled || dragging || ev.button !== 0) return;
  runGhostSession(ev, src, sourceEl, { immediate: false, handle: ev.currentTarget as HTMLElement | null });
}

export interface HandOffOptions {
  /** Checked on every move: true hands the pointer back to the caller
   *  (e.g. it left the shell bar again). */
  shouldReturn?(e: PointerEvent): boolean;
  /** The ghost is gone and the caller's own drag continues from `e`. */
  onReturn?(e: PointerEvent): void;
  /** The pointer was released (or the drag cancelled) in ghost mode.
   *  `dropped` = a drop target accepted the activity. */
  onEnd?(result: { dropped: boolean }): void;
}

/**
 * Switch a drag a layout runs itself (e.g. Free Window moving an activity) into
 * this ghost mode mid-gesture, from the current pointer event — so drops on
 * workspace pills etc. work in every layout. Ignores the layout drag policy
 * (the caller decided); the ghost appears at once, no threshold.
 */
export function handOffActivityDrag(
  ev: PointerEvent, src: DragSource, sourceEl: HTMLElement, handle: HTMLElement | null, opts: HandOffOptions = {},
): boolean {
  if (dragging) return false;
  runGhostSession(ev, src, sourceEl, { immediate: true, handle, ...opts });
  return true;
}
