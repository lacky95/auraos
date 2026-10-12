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

/**
 * Arm a potential drag from a title-bar `pointerdown`. Nothing visible
 * happens until the pointer travels past the threshold, so clicks and
 * double-click rename keep working.
 */
export function beginWindowDrag(ev: PointerEvent, src: DragSource, sourceEl: HTMLElement): void {
  if (!policy?.enabled || dragging || ev.button !== 0) return;
  const handle = ev.currentTarget as HTMLElement | null;
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

  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    if (!started) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD_PX) return;
      start();
    }
    e.preventDefault();
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

  const finish = (commit: boolean) => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('keydown', key, true);
    if (!started) return;
    const hit = current;
    setCurrent(null);
    try { handle?.releasePointerCapture(pointerId); } catch { /* already released */ }
    ghost?.remove();
    sourceEl.removeAttribute('data-drag-source');
    document.body.classList.remove('aura-window-dragging');
    dragging = false;
    // Swallow the click that follows a real drag so title-bar handlers don't fire.
    // The click (if any) is dispatched right after pointerup, so a 0ms
    // timeout removes the swallower before any later, genuine click.
    const swallow = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); };
    window.addEventListener('click', swallow, true);
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    if (commit && hit) {
      Promise.resolve(hit.target.drop(src, hit.match.data)).catch((err) =>
        console.warn('[windowDrag] drop failed', err));
    }
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
}
