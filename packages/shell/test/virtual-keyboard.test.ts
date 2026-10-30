/**
 * Virtual keyboard: the synthetic-key receiver (lib/keyboard/receiverScript.ts)
 * and the layout helpers. Runs the receiver in happy-dom and drives it with
 * `aura.key.synthetic` messages, the way the shell does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { SYNTHETIC_RECEIVER_JS } from '../src/lib/keyboard/receiverScript.ts';
import { parseCombo, keyForChar, layoutById, displayFor, LAYOUTS } from '../src/components/shell/keyboard/layouts.ts';

function setup(html: string) {
  const win = new Window({ url: 'http://localhost/' });
  win.document.body.innerHTML = html;
  win.eval(SYNTHETIC_RECEIVER_JS);
  // happy-dom: the page's own `window` (what the receiver compares against) is
  // not the host-side Window object, so post with the in-page one.
  const self = win.eval('window') as unknown;
  const send = async (msg: Record<string, unknown>, source: unknown = self) => {
    const ev = new win.MessageEvent('message', { data: { type: 'aura.key.synthetic', ...msg }, source: source as never });
    win.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 0));
  };
  const tap = async (key: string, code = '', extra: Record<string, unknown> = {}) => {
    await send({ action: 'keydown', key, code, ...extra });
    await send({ action: 'keyup', key, code, ...extra });
  };
  return { win, doc: win.document, send, tap };
}

test('types printable characters into a focused input', async () => {
  const { doc, tap } = setup('<input id="i" type="text">');
  const i = doc.getElementById('i') as unknown as HTMLInputElement;
  i.focus();
  let inputs = 0;
  i.addEventListener('input', () => inputs++);
  await tap('h', 'KeyH');
  await tap('i', 'KeyI');
  assert.equal(i.value, 'hi');
  assert.equal(inputs, 2);
});

test('Backspace, arrows and Home/End edit the field', async () => {
  const { doc, tap } = setup('<input id="i" type="text" value="abcd">');
  const i = doc.getElementById('i') as unknown as HTMLInputElement;
  i.focus();
  i.setSelectionRange(4, 4);
  await tap('Backspace', 'Backspace');
  assert.equal(i.value, 'abc');
  await tap('ArrowLeft', 'ArrowLeft');
  assert.equal(i.selectionStart, 2);
  await tap('Home', 'Home');
  await tap('X', 'KeyX', { shift: true });
  assert.equal(i.value, 'Xabc');
  await tap('End', 'End');
  await tap('Delete', 'Delete');           // nothing after the caret
  assert.equal(i.value, 'Xabc');
});

test('an app that handles the key itself (preventDefault) is not edited twice', async () => {
  const { doc, tap } = setup('<input id="i" type="text">');
  const i = doc.getElementById('i') as unknown as HTMLInputElement;
  i.focus();
  i.addEventListener('keydown', (e) => e.preventDefault());
  await tap('a', 'KeyA');
  assert.equal(i.value, '');
});

test('Ctrl combos reach listeners but do not insert text', async () => {
  const { doc, tap } = setup('<input id="i" type="text">');
  const i = doc.getElementById('i') as unknown as HTMLInputElement;
  i.focus();
  const seen: string[] = [];
  i.addEventListener('keydown', (e) => seen.push(`${e.ctrlKey ? 'Ctrl+' : ''}${e.key}`));
  await tap('s', 'KeyS', { ctrl: true });
  assert.deepEqual(seen, ['Ctrl+s']);
  assert.equal(i.value, '');
});

test('Enter adds a newline in a textarea; text action inserts a string', async () => {
  const { doc, tap, send } = setup('<textarea id="t"></textarea>');
  const t = doc.getElementById('t') as unknown as HTMLTextAreaElement;
  t.focus();
  await tap('a', 'KeyA');
  await tap('Enter', 'Enter');
  await send({ action: 'text', text: 'xyz' });
  assert.equal(t.value, 'a\nxyz');
});

test('only messages from window.parent are accepted', async () => {
  const { doc, send } = setup('<input id="i" type="text">');
  const i = doc.getElementById('i') as unknown as HTMLInputElement;
  i.focus();
  await send({ action: 'keydown', key: 'z', code: 'KeyZ' }, {} /* some other window */);
  assert.equal(i.value, '');
});

test('xterm helper textarea gets key events only (xterm turns them into data)', async () => {
  const { doc, tap } = setup('<textarea id="x" class="xterm-helper-textarea"></textarea>');
  const x = doc.getElementById('x') as unknown as HTMLTextAreaElement;
  x.focus();
  const events: string[] = [];
  for (const type of ['keydown', 'keypress', 'keyup']) x.addEventListener(type, (e) => events.push(`${type}:${(e as KeyboardEvent).key}`));
  await tap('l', 'KeyL');
  await tap('Enter', 'Enter');
  assert.equal(x.value, '');
  assert.deepEqual(events, ['keydown:l', 'keypress:l', 'keyup:l', 'keydown:Enter', 'keypress:Enter', 'keyup:Enter']);
});

test('layout helpers: combos, chars, labels', () => {
  assert.deepEqual(parseCombo('{ctrl+alt+delete}'), { key: { key: 'Delete', code: 'Delete', keyCode: 46 }, mods: { ctrl: true, alt: true } });
  assert.deepEqual(parseCombo('{ctrl+c}')?.key, { key: 'c', code: 'KeyC', keyCode: 67 });
  assert.equal(parseCombo('{bksp}'), null);
  assert.equal(parseCombo('{foo+c}'), null);
  assert.deepEqual(keyForChar('7'), { key: '7', code: 'Digit7', keyCode: 55 });
  assert.equal(keyForChar('ü').code, '');
  for (const l of LAYOUTS) assert.ok(layoutById(l.id)['default']!.length > 0, l.id);
  assert.equal(displayFor(layoutById('shortcuts'))['{ctrl+shift+t}'], 'Ctrl+Shift+T');
  assert.equal(layoutById('custom', null), layoutById('full'));
});

// ── Floating keyboard geometry (lib/keyboard/floatGesture.ts) ───────────
import { moveRect, resizeRect, clampRect, MIN_SIZE } from '../src/lib/keyboard/floatGesture.ts';

const VP = { width: 1000, height: 800 };
const R = { left: 100, top: 100, width: 400, height: 300 };

test('moveRect follows the pointer and keeps part of the keyboard on screen', () => {
  assert.deepEqual(moveRect(R, 50, -20, VP), { left: 150, top: 80, width: 400, height: 300 });
  const far = moveRect(R, 5000, 5000, VP);
  assert.equal(far.left, VP.width - 80);
  assert.equal(far.top, VP.height - 40);
  const up = moveRect(R, 0, -5000, VP);
  assert.equal(up.top, 0);                       // header never goes above the screen
  const left = moveRect(R, -5000, 0, VP);
  assert.equal(left.left, 80 - R.width);         // 80 px stays visible
});

test('resizeRect: east/south grow the far edges, capped at the screen', () => {
  assert.deepEqual(resizeRect(R, 'se', 60, 40, VP), { left: 100, top: 100, width: 460, height: 340 });
  const big = resizeRect(R, 'se', 5000, 5000, VP);
  assert.equal(big.left + big.width, VP.width);
  assert.equal(big.top + big.height, VP.height);
  assert.deepEqual(resizeRect(R, 'e', 10, 99, VP), { left: 100, top: 100, width: 410, height: 300 });
  assert.deepEqual(resizeRect(R, 's', 99, 10, VP), { left: 100, top: 100, width: 400, height: 310 });
});

test('resizeRect: west/north keep the opposite edge fixed', () => {
  const w = resizeRect(R, 'w', -50, 0, VP);
  assert.equal(w.left, 50);
  assert.equal(w.left + w.width, R.left + R.width);
  const n = resizeRect(R, 'n', 0, 30, VP);
  assert.equal(n.top, 130);
  assert.equal(n.top + n.height, R.top + R.height);
  const nw = resizeRect(R, 'nw', -500, -500, VP);   // can't pass the screen edge
  assert.deepEqual([nw.left, nw.top], [0, 0]);
  assert.equal(nw.left + nw.width, R.left + R.width);
});

test('resizeRect never goes below the minimum size, from any edge', () => {
  for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const) {
    const r = resizeRect(R, edge, edge.includes('w') ? 5000 : -5000, edge.includes('n') ? 5000 : -5000, VP);
    assert.ok(r.width >= MIN_SIZE.width && r.height >= MIN_SIZE.height, edge);
    if (edge.includes('w')) assert.equal(r.left + r.width, R.left + R.width, `${edge} right edge`);
    if (edge.includes('n')) assert.equal(r.top + r.height, R.top + R.height, `${edge} bottom edge`);
  }
});

test('clampRect fits stored rects to a smaller screen', () => {
  const r = clampRect({ left: 1500, top: 900, width: 2000, height: 50 }, VP);
  assert.deepEqual(r, { left: VP.width - 80, top: VP.height - 40, width: VP.width, height: MIN_SIZE.height });
});

// ── Focus recovery: keys must not get lost on <body> ────────────────────

test('nothing focused: keys go to the terminal input (xterm helper textarea)', async () => {
  const { doc, tap } = setup('<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>');
  const x = doc.querySelector('.xterm-helper-textarea') as unknown as HTMLTextAreaElement;
  (doc.activeElement as unknown as HTMLElement | null)?.blur?.();
  const keys: string[] = [];
  x.addEventListener('keydown', (e) => keys.push((e as KeyboardEvent).key));
  await tap('l', 'KeyL');
  assert.deepEqual(keys, ['l']);
  assert.equal(doc.activeElement, x);
});

test('nothing focused: keys go back to the field that had focus last', async () => {
  const { doc, tap } = setup('<input id="a" type="text"><input id="b" type="text">');
  const b = doc.getElementById('b') as unknown as HTMLInputElement;
  b.focus();
  b.blur();                                   // e.g. a tap that left only <body> focused
  await tap('k', 'KeyK');
  assert.equal(b.value, 'k');
});
