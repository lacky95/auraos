/**
 * Pure window-navigation helpers used by the dispatcher's Nav mode.
 *
 * Inputs are minimal (an ordered viewId list + the optional bbox rects for
 * stack-style layouts) so this module stays trivially testable. The shell
 * layer wires these into the keymap dispatcher's `aura.nav.up/down/left/
 * right` handlers — see `pages/index.astro`.
 */

export type NavDirection = 'up' | 'down' | 'left' | 'right';

export interface ViewRect {
  viewId: string;
  /** Center-x of the slot in CSS pixels. */
  cx: number;
  /** Center-y of the slot. */
  cy: number;
  /** Slot width. */
  w:  number;
  /** Slot height. */
  h:  number;
}

/**
 * Compute the next view to focus given the current one + a direction.
 *
 * For the tiling layout the geometry collapses to a grid (cols = ceil(sqrt(n)))
 * and we step by row/column. For stack/windowed layouts we pick the closest
 * neighbour whose center lies in the requested half-plane (and slightly off
 * the centerline so a strictly-aligned column still resolves).
 *
 * Returns `currentViewId` (a no-op) when no neighbour exists in that direction —
 * keeping the focus where it is so the user notices the wall.
 */
export function nextInDirection(
  rects: readonly ViewRect[],
  currentViewId: string,
  dir: NavDirection,
): string {
  if (rects.length === 0) return currentViewId;
  const current = rects.find((r) => r.viewId === currentViewId);
  if (!current) return rects[0]!.viewId;

  // Distance helper — lower is better.
  // Penalise off-axis movement so straight steps win over diagonals.
  const score = (cand: ViewRect): number | null => {
    const dx = cand.cx - current.cx;
    const dy = cand.cy - current.cy;
    if (dir === 'up'    && dy >= -1) return null;
    if (dir === 'down'  && dy <=  1) return null;
    if (dir === 'left'  && dx >= -1) return null;
    if (dir === 'right' && dx <=  1) return null;
    // Primary axis = the direction we're moving in; orthogonal axis is the
    // penalty multiplier.
    const along = dir === 'up' || dir === 'down' ? Math.abs(dy) : Math.abs(dx);
    const off   = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
    return along + off * 2;
  };

  let best: ViewRect | null = null;
  let bestScore = Infinity;
  for (const cand of rects) {
    if (cand.viewId === currentViewId) continue;
    const s = score(cand);
    if (s === null) continue;
    if (s < bestScore) { bestScore = s; best = cand; }
  }
  return best ? best.viewId : currentViewId;
}

/**
 * Derive `ViewRect`s for a tiling grid given the desktop dimensions and the
 * ordered viewIds visible in the active workspace. Uses the same
 * `cols = ceil(sqrt(n))` rule the `TilingLayout` component renders with so
 * navigation matches what the user sees.
 */
export function tilingRects(viewIds: readonly string[], desktopWidth: number, desktopHeight: number): ViewRect[] {
  const n = viewIds.length;
  if (n === 0) return [];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const w = desktopWidth  / cols;
  const h = desktopHeight / rows;
  return viewIds.map((viewId, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      viewId,
      cx: col * w + w / 2,
      cy: row * h + h / 2,
      w,
      h,
    };
  });
}

/**
 * Read a `ViewRect` from a slot's DOM bounding box. Falls back to (0,0,0,0)
 * for slots that aren't laid out yet. Used by stack/windowed layouts where
 * slot positions come from the layout strategy at render time.
 */
export function rectFromSlot(slot: Element, viewId: string): ViewRect {
  const bb = (slot as HTMLElement).getBoundingClientRect();
  return {
    viewId,
    cx: bb.left + bb.width  / 2,
    cy: bb.top  + bb.height / 2,
    w:  bb.width,
    h:  bb.height,
  };
}
