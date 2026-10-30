/**
 * Grid geometry shared by the browser tiling strategy (strategies/grid.ts)
 * and the server-rendered first paint (pages/index.astro), so the SSR slots
 * already sit in the cells the client strategy will give them. Pure and
 * dependency-free: safe to import on the server.
 */

export function tilingShape(n: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}

/** Cell of activity `i` of `n` in the tiling grid; the last one in a column
 *  expands down over empty cells below it. 1-based, `baseRow` = first row. */
export function tilingCell(i: number, n: number, baseRow = 1): { col: number; row: number; span: number } {
  const { cols, rows } = tilingShape(n);
  const c = i % cols;
  const r = Math.floor(i / cols);
  let span = 1;
  while (r + span < rows && (r + span) * cols + c >= n) span++;
  return { col: c + 1, row: r + baseRow, span };
}

export interface SsrGridLayout {
  container: string;
  slots: string[];
}

/**
 * Inline CSS for the server-rendered desktop: the container and each of `n`
 * slots. Grid layouts (tiling / rows / columns / fullscreen) match the client
 * strategy exactly; any other layout (Free Window) starts as tiling and is
 * re-placed by its strategy once the desktop script runs — restyling a slot
 * never reloads its iframe.
 */
export function ssrGridLayout(layoutId: string, n: number): SsrGridLayout {
  const base = 'position:absolute;inset:0;display:grid;background:var(--aura-color-bg);';
  const cell = (col: number, row: number, span = 1) =>
    `grid-column:${col};grid-row:${span > 1 ? `${row} / span ${span}` : row};`;
  if (layoutId === 'rows') {
    return {
      container: `${base}gap:2px;grid-template-columns:1fr;grid-template-rows:repeat(${Math.max(1, n)}, 1fr);`,
      slots: Array.from({ length: n }, (_, i) => cell(1, i + 1)),
    };
  }
  if (layoutId === 'columns') {
    return {
      container: `${base}gap:2px;grid-template-columns:repeat(${Math.max(1, n)}, minmax(0, 1fr));grid-template-rows:1fr;`,
      slots: Array.from({ length: n }, (_, i) => cell(i + 1, 1)),
    };
  }
  if (layoutId === 'fullscreen') {
    return {
      container: `${base}gap:0;grid-template-columns:1fr;grid-template-rows:1fr;`,
      slots: Array.from({ length: n }, () => cell(1, 1)),
    };
  }
  const { cols, rows } = tilingShape(n);
  return {
    container: `${base}gap:2px;grid-template-columns:repeat(${cols}, minmax(0, 1fr));grid-template-rows:repeat(${rows}, 1fr);`,
    slots: Array.from({ length: n }, (_, i) => {
      const c = tilingCell(i, n);
      return cell(c.col, c.row, c.span);
    }),
  };
}
