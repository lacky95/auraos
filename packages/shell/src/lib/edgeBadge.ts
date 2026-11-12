/**
 * Press-and-hold drag for things that live on a screen edge (flight tabs).
 *
 * Same feel as the bars edge badge (StatusBar.astro): a short tap is a tap; a
 * hold of `holdMs` without moving more than `slop` px "lifts" the element,
 * after which it follows the pointer and snaps to the nearest edge on drop.
 * Moving past `slop` BEFORE the hold fires cancels (a touch scroll / swipe),
 * so a tab never steals a gesture meant for the page under it.
 *
 * Coordinates handed to the callbacks are body-local px (`toLocal`), the
 * space fixed children of the zoomed <body> are positioned in.
 */

import { toLocal } from './keyboard/floatGesture.ts';

export const HOLD_MS = 200;
export const HOLD_SLOP = 10;

export interface EdgeDragHandlers {
  onTap: () => void;
  /** The hold fired: the element is now being dragged. */
  onLift?: () => void;
  onDrag: (x: number, y: number) => void;
  onDrop: (x: number, y: number) => void;
  holdMs?: number;
  slop?: number;
}

/** Wire tap / hold-drag onto `el`. Returns a disposer. */
export function attachEdgeDrag(el: HTMLElement, h: EdgeDragHandlers): () => void {
  const holdMs = h.holdMs ?? HOLD_MS;
  const slop = h.slop ?? HOLD_SLOP;

  const down = (ev: PointerEvent) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    ev.preventDefault();
    const id = ev.pointerId;
    const sx = ev.clientX, sy = ev.clientY;
    let lifted = false, cancelled = false, last = toLocal(sx, sy);
    try { el.setPointerCapture(id); } catch { /* not capturable */ }

    const timer = setTimeout(() => {
      if (cancelled) return;
      lifted = true;
      el.classList.add('is-lifted');
      document.body.classList.add('aura-stack-dragging');
      h.onLift?.();
      h.onDrag(last.x, last.y);
    }, holdMs);

    let raf = 0;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      last = toLocal(e.clientX, e.clientY);
      if (!lifted) {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) > slop) { cancelled = true; clearTimeout(timer); }
        return;
      }
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; h.onDrag(last.x, last.y); });
    };
    let ended = false;
    const end = (e: Event) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      el.removeEventListener('lostpointercapture', end);
      window.removeEventListener('blur', end);
      try { if (el.hasPointerCapture(id)) el.releasePointerCapture(id); } catch { /* gone */ }
      if (lifted) {
        el.classList.remove('is-lifted');
        document.body.classList.remove('aura-stack-dragging');
        h.onDrop(last.x, last.y);
      } else if (!cancelled && e.type === 'pointerup') {
        h.onTap();
      }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    window.addEventListener('blur', end);
  };

  // Keyboard: Enter / Space taps (the tab is a button).
  const key = (ev: KeyboardEvent) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); h.onTap(); }
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('keydown', key);
  return () => { el.removeEventListener('pointerdown', down); el.removeEventListener('keydown', key); };
}
