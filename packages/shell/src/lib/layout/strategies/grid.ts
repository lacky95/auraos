/**
 * The CSS-grid layouts: tiling, rows, columns, fullscreen. Each activity is
 * pinned to an explicit (grid-row, grid-column) by its index — never by DOM
 * order — because moving a slot in the DOM would reload its iframe.
 */
import { LAYOUT_DRAG_POLICIES } from '../../layoutDragPolicies.ts';
import type { LayoutRenderContext, ShellLayoutStrategy } from '../types.ts';

const BASE_STYLE = {
  display: 'grid',
  background: 'var(--aura-color-bg)',
  alignItems: '', justifyContent: '', flexDirection: '',
};

/** Rows template with the host's minimized strip (row 1) when shown. */
function rowsTemplate(ctx: LayoutRenderContext, rows: string): string {
  return ctx.stripShown ? `auto ${rows}` : rows;
}

function pin(el: HTMLElement, col: number, row: number, span = 1): void {
  el.style.gridColumn = String(col);
  el.style.gridRow    = span > 1 ? `${row} / span ${span}` : String(row);
}
function unpin(el: HTMLElement): void {
  el.style.removeProperty('grid-column');
  el.style.removeProperty('grid-row');
}

function tilingShape(n: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}

/** Square-ish grid; an activity expands down over empty cells below it, so
 *  e.g. 3 activities in a 2×2 grid give the right-hand one full height. */
export const tiling: ShellLayoutStrategy = {
  id: 'tiling',
  dragPolicy: LAYOUT_DRAG_POLICIES['tiling'],
  containerStyle(ctx) {
    const { cols, rows } = tilingShape(ctx.visible.length);
    return {
      ...BASE_STYLE, gap: '2px',
      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      gridTemplateRows: rowsTemplate(ctx, `repeat(${rows}, 1fr)`),
    };
  },
  place(el, _v, i, ctx) {
    const n = ctx.visible.length;
    const { cols, rows } = tilingShape(n);
    const c = i % cols;
    const r = Math.floor(i / cols);
    let span = 1;
    while (r + span < rows && (r + span) * cols + c >= n) span++;
    pin(el, c + 1, r + ctx.baseRow, span);
  },
  release: unpin,
};

export const rows: ShellLayoutStrategy = {
  id: 'rows',
  dragPolicy: LAYOUT_DRAG_POLICIES['rows'],
  containerStyle(ctx) {
    return {
      ...BASE_STYLE, gap: '2px',
      gridTemplateColumns: '1fr',
      gridTemplateRows: rowsTemplate(ctx, `repeat(${ctx.visible.length}, 1fr)`),
    };
  },
  place(el, _v, i, ctx) { pin(el, 1, i + ctx.baseRow); },
  release: unpin,
};

export const columns: ShellLayoutStrategy = {
  id: 'columns',
  dragPolicy: LAYOUT_DRAG_POLICIES['columns'],
  containerStyle(ctx) {
    return {
      ...BASE_STYLE, gap: '2px',
      gridTemplateColumns: `repeat(${ctx.visible.length}, minmax(0, 1fr))`,
      gridTemplateRows: rowsTemplate(ctx, '1fr'),
    };
  },
  place(el, _v, i, ctx) { pin(el, i + 1, ctx.baseRow); },
  release: unpin,
};

/** 1×1 grid — every activity in the same cell; the focused one wins via DOM
 *  order / z-index, siblings stay warm underneath. */
export const fullscreen: ShellLayoutStrategy = {
  id: 'fullscreen',
  dragPolicy: LAYOUT_DRAG_POLICIES['fullscreen'],
  containerStyle(ctx) {
    return {
      ...BASE_STYLE, gap: '0',
      gridTemplateColumns: '1fr',
      gridTemplateRows: rowsTemplate(ctx, '1fr'),
    };
  },
  place(el, _v, _i, ctx) { pin(el, 1, ctx.baseRow); },
  release: unpin,
};
