/**
 * Virtual keyboard: Space typed into a text field must not scroll the page.
 *
 * WebKit (Safari, every iPad/iPhone browser) runs the space key's default
 * action, "scroll by a screen", even for the receiver's untrusted `keypress`,
 * so the space was typed and the app's page or scroll box jumped. The
 * receiver now cancels the keypress default on a text target after the app's
 * own listeners ran. happy-dom runs no default actions, so these tests check
 * the contract: the default is cancelled on text targets only, the app still
 * sees an uncancelled event, and an app that cancels it still stops the edit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { SYNTHETIC_RECEIVER_JS } from '../src/lib/keyboard/receiverScript.ts';

function setup(html: string) {
  const win = new Window({ url: 'http://localhost/' });
  win.document.body.innerHTML = html;
  win.eval(SYNTHETIC_RECEIVER_JS);
  const self = win.eval('window') as unknown;
  const send = async (msg: Record<string, unknown>) => {
    win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'aura.key.synthetic', ...msg }, source: self as never }));
    await new Promise((r) => setTimeout(r, 0));
  };
  const tap = async (key: string, code: string) => {
    await send({ action: 'keydown', key, code, keyCode: key === ' ' ? 32 : key.charCodeAt(0) });
    await send({ action: 'keyup', key, code });
  };
  /** Every keypress, with what the app saw during dispatch and the final state. */
  const presses: Array<{ ev: KeyboardEvent; seenPrevented: boolean }> = [];
  win.document.addEventListener('keypress', (e) => { presses.push({ ev: e as unknown as KeyboardEvent, seenPrevented: e.defaultPrevented }); });
  return { win, doc: win.document, send, tap, presses };
}

for (const [name, html] of [
  ['a textarea', '<div style="overflow:auto;height:50px"><textarea id="t"></textarea></div>'],
  ['an input', '<input id="t" type="text">'],
  ['a contenteditable', '<div id="t" contenteditable="true"></div>'],
] as const) {
  test(`Space in ${name}: typed once, the keypress default (WebKit page scroll) is cancelled`, async () => {
    const { doc, tap, presses } = setup(html);
    const t = doc.getElementById('t') as unknown as HTMLElement;
    t.focus();
    if (name === 'a contenteditable') {
      // happy-dom has no execCommand editing: record the command instead.
      const cmds: string[] = [];
      (doc as unknown as { execCommand: (c: string, u: boolean, a: string) => boolean }).execCommand = (c, _u, a) => { cmds.push(`${c}:${a}`); return true; };
      await tap(' ', 'Space');
      assert.deepEqual(cmds, ['insertText: ']);
    } else {
      await tap(' ', 'Space');
      assert.equal((t as HTMLInputElement).value, ' ');
    }
    assert.equal(presses.length, 1);
    assert.equal(presses[0]!.seenPrevented, false);       // the app's listeners saw an uncancelled event
    assert.equal(presses[0]!.ev.defaultPrevented, true);  // …and the engine's default was cancelled afterwards
  });
}

test('Space with nothing editable focused: the keypress keeps its default (unchanged)', async () => {
  const { tap, presses } = setup('<div style="height:3000px">page</div>');
  await tap(' ', 'Space');
  assert.equal(presses.length, 1);
  assert.equal(presses[0]!.ev.defaultPrevented, false);
});

test('an app that cancels the Space keypress still stops the edit', async () => {
  const { doc, tap } = setup('<textarea id="t"></textarea>');
  const t = doc.getElementById('t') as unknown as HTMLTextAreaElement;
  t.focus();
  t.addEventListener('keypress', (e) => e.preventDefault());
  await tap(' ', 'Space');
  await tap('a', 'KeyA');
  assert.equal(t.value, '');
});

test('an app listener on window still runs and sees the keypress uncancelled', async () => {
  const { win, doc, tap } = setup('<input id="t" type="text">');
  (doc.getElementById('t') as unknown as HTMLInputElement).focus();
  const seen: boolean[] = [];
  win.addEventListener('keypress', (e) => { seen.push(e.defaultPrevented); });
  await tap(' ', 'Space');
  assert.deepEqual(seen, [false]);
  assert.equal((doc.getElementById('t') as unknown as HTMLInputElement).value, ' ');
});

test('xterm: Space keypress reaches the terminal, its default is cancelled', async () => {
  const { doc, send, presses } = setup('<div class="xterm"><textarea class="xterm-helper-textarea" id="x"></textarea></div>');
  const x = doc.getElementById('x') as unknown as HTMLTextAreaElement;
  x.focus();
  const got: string[] = [];
  x.addEventListener('keypress', (e) => got.push((e as unknown as KeyboardEvent).key));
  await send({ action: 'keydown', key: ' ', code: 'Space', keyCode: 32 });
  await send({ action: 'text', text: ' ' });
  assert.deepEqual(got, [' ', ' ']);
  assert.equal(x.value, '');                                // xterm types, not the receiver
  assert.ok(presses.every((p) => !p.seenPrevented && p.ev.defaultPrevented));
});
