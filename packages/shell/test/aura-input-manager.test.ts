/**
 * AuraInputManager target choice (lib/keyboard/AuraInputManager.ts), in
 * happy-dom with two app windows, the way the desktop lays them out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

const win = new Window({ url: 'http://localhost/' });
for (const k of ['window', 'document', 'HTMLElement', 'HTMLIFrameElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'CSS'] as const) {
  (globalThis as Record<string, unknown>)[k] = (win as unknown as Record<string, unknown>)[k];
}
win.document.body.innerHTML = `
  <div class="app-slot" data-view-id="term"><span class="slot-title">Terminal</span><iframe id="term"></iframe></div>
  <div class="app-slot" data-view-id="tri"><span class="slot-title">Trilium</span><iframe id="tri"></iframe></div>`;
// happy-dom does no layout; both windows are on screen.
Object.defineProperty(win.HTMLElement.prototype, 'offsetParent', { get() { return win.document.body; } });
const { inputManager } = await import('../src/lib/keyboard/AuraInputManager.ts');

const frame = (id: string) => win.document.getElementById(id) as unknown as HTMLIFrameElement;
const tapInto = (f: HTMLIFrameElement) =>
  win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'aura.pointerdown' }, source: f.contentWindow as never }));

test('a tap into another window wins over a stale activeElement (iPad Safari keeps the old iframe focused)', () => {
  const im = inputManager();
  frame('term').focus();
  assert.equal(win.document.activeElement, frame('term'));
  const t1 = im.resolveTarget();
  assert.equal(t1?.kind === 'iframe' && t1.frame.id, 'term');

  tapInto(frame('tri'));                       // Safari: activeElement stays on the terminal
  assert.equal(win.document.activeElement, frame('term'));
  const t2 = im.resolveTarget();
  assert.equal(t2?.kind === 'iframe' && t2.frame.id, 'tri');
  assert.equal(t2?.label, 'Trilium');
});

test('tapping back into the first window makes it the target again', () => {
  const im = inputManager();
  tapInto(frame('term'));
  const t = im.resolveTarget();
  assert.equal(t?.kind === 'iframe' && t.frame.id, 'term');
});

test('focus moving into a window (window switcher, no tap) makes it the target', () => {
  const im = inputManager();
  frame('tri').focus();
  const t = im.resolveTarget();
  assert.equal(t?.kind === 'iframe' && t.frame.id, 'tri');
});
