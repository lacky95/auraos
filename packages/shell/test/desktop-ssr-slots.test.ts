// Server-rendered desktop slots: same markup as the browser builds, grid cells
// matching the client strategies (lib/desktop/slotMarkup.ts, lib/layout/gridShape.ts).
//
//   cd packages/shell && npx tsx --test test/desktop-ssr-slots.test.ts
import { dom } from './dom.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotInnerHtml, iframeHtml, escapeHtml } from '../src/lib/desktop/slotMarkup.ts';
import { ssrGridLayout, tilingCell, tilingShape } from '../src/lib/layout/gridShape.ts';

test('slot markup has every hook updateSlot() reads', () => {
  const el = dom.document.createElement('div');
  el.innerHTML = slotInnerHtml({ minimizable: false });
  for (const sel of [
    '.slot-chrome', '.slot-title', '.slot-window-name', '.slot-title-trail', '.slot-title-id',
    '.slot-controls', '.slot-focus-hint', '.slot-layout-btns', '.slot-minimize-btn', '.slot-maximize-btn',
    '.slot-fullsize-btn', '.slot-close-btn', '[data-action="refresh"]', '[data-action="rename"]', '.slot-body',
  ]) {
    assert.ok(el.querySelector(sel), `missing ${sel}`);
  }
  assert.equal((el.querySelector('.slot-minimize-btn') as HTMLElement).getAttribute('style')!.includes('display:none'), true);
  el.innerHTML = slotInnerHtml({ minimizable: true });
  assert.equal((el.querySelector('.slot-minimize-btn') as HTMLElement).getAttribute('style')!.includes('display:none'), false);
});

test('the server puts the iframe inside .slot-body, attributes escaped', () => {
  const el = dom.document.createElement('div');
  el.innerHTML = slotInnerHtml({ bodyHtml: iframeHtml('/api/proxy/x-1/?a=1&b="2"', 'A <b>') });
  const ifr = el.querySelector('.slot-body > iframe') as HTMLIFrameElement;
  assert.ok(ifr);
  assert.equal(ifr.getAttribute('src'), '/api/proxy/x-1/?a=1&b="2"');
  assert.equal(ifr.getAttribute('title'), 'A <b>');
  assert.equal(escapeHtml(`<&"'>`), '&lt;&amp;&quot;&#39;&gt;');
});

test('tiling cells: the last one in a column spans the empty cells below it', () => {
  assert.deepEqual(tilingShape(3), { cols: 2, rows: 2 });
  assert.deepEqual(tilingCell(0, 3), { col: 1, row: 1, span: 1 });
  assert.deepEqual(tilingCell(1, 3), { col: 2, row: 1, span: 2 });
  assert.deepEqual(tilingCell(2, 3), { col: 1, row: 2, span: 1 });
  assert.deepEqual(tilingCell(0, 1, 2), { col: 1, row: 2, span: 1 });
});

test('ssrGridLayout matches the client strategies per layout', () => {
  const t = ssrGridLayout('tiling', 3);
  assert.match(t.container, /grid-template-columns:repeat\(2, minmax\(0, 1fr\)\)/);
  assert.deepEqual(t.slots, ['grid-column:1;grid-row:1;', 'grid-column:2;grid-row:1 / span 2;', 'grid-column:1;grid-row:2;']);
  assert.deepEqual(ssrGridLayout('rows', 2).slots, ['grid-column:1;grid-row:1;', 'grid-column:1;grid-row:2;']);
  assert.deepEqual(ssrGridLayout('columns', 2).slots, ['grid-column:1;grid-row:1;', 'grid-column:2;grid-row:1;']);
  assert.deepEqual(ssrGridLayout('fullscreen', 2).slots, ['grid-column:1;grid-row:1;', 'grid-column:1;grid-row:1;']);
  // Free Window (and unknown ids) start as tiling.
  assert.deepEqual(ssrGridLayout('stack', 3).slots, t.slots);
});
