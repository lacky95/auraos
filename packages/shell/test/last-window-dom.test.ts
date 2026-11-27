/**
 * D101: the last-window dialog (components/shell/LastWindowDialog.astro +
 * lib/lastWindowDialog.ts) in happy-dom: centred, focus on Keep running, the
 * Tab trap, arrows between the answers, Enter, Esc = Keep running, the
 * remembered choice written to the user's preference, Stop as the lifecycle
 * stop only while idle, the switch, and who is never asked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dom } from './dom.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const astro = read('../src/components/shell/LastWindowDialog.astro');
const markup = astro.match(/<dialog[\s\S]*?<\/dialog>/)![0];
const styles = astro.match(/<style is:global>([\s\S]*?)<\/style>/)![1]!;
const reset = read('../src/styles/global.css').replace(/@import[^;]+;/g, '');
dom.document.head.innerHTML = `<style>${reset}</style><style>${styles}</style>`;
dom.document.body.innerHTML = markup;

// ── the server, in memory ──────────────────────────────────────────────────

let pref: unknown = null;
const puts: unknown[] = [];
const stops: string[] = [];
let busyInstances = new Set<string>();
const manifests: Record<string, unknown> = {
  'io.bg.app': { id: 'io.bg.app', name: 'Background App', componentType: 'activity', backgroundService: true },
};
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
  const url = new URL(String(input), 'https://aura-shell.test');
  const method = init?.method ?? 'GET';
  if (url.pathname === '/api/kv/os/lastWindow') {
    if (method === 'PUT') { pref = JSON.parse(init!.body!).value; puts.push(pref); return json({ value: pref, updatedAt: Date.now() }); }
    return pref === null ? json({ error: 'No value' }, 404) : json({ value: pref, updatedAt: 1 });
  }
  const stop = url.pathname.match(/^\/api\/instances\/([^/]+)\/stop$/);
  if (stop && method === 'POST') {
    const id = decodeURIComponent(stop[1]!);
    assert.equal(url.searchParams.get('ifIdle'), '1', 'Stop always asks for an idle instance');
    if (busyInstances.has(id)) return json({ error: 'not-idle' }, 409);
    stops.push(id);
    return json({ stopped: id });
  }
  const app = url.pathname.match(/^\/api\/apps\/([^/]+)\/status$/);
  if (app) return json({ manifest: manifests[decodeURIComponent(app[1]!)] ?? null });
  return json({ error: 'not-found' }, 404);
}) as typeof fetch;

const { afterUserClose } = await import('../src/lib/lastWindowDialog.ts');

const $ = <T extends HTMLElement = HTMLElement>(id: string) => dom.document.getElementById(id) as unknown as T;
const dlg = $<HTMLDialogElement>('aura-last-window');
const remember = $<HTMLInputElement>('aura-last-window-remember');
const keep = $<HTMLButtonElement>('aura-last-window-keep');
const stopBtn = $<HTMLButtonElement>('aura-last-window-stop');
const focused = () => dom.document.activeElement as unknown as HTMLElement | null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(5);
  }
}

function key(k: string, opts: { shiftKey?: boolean; repeat?: boolean } = {}): boolean {
  const target = (dom.document.activeElement ?? dom.document.body) as unknown as EventTarget;
  const ev = new dom.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts });
  target.dispatchEvent(ev as unknown as Event);
  return ev.defaultPrevented;
}

const BG = { name: 'Background App', componentType: 'activity', backgroundService: true };
let n = 0;
function lastClose(over: Record<string, unknown> = {}) {
  const inst = `io.bg.app-${++n}`;
  return {
    closed: true, activityId: `${inst}#a1`, parentInstanceId: inst, appId: 'io.bg.app',
    lastOfInstance: true, instanceStopped: false, instanceRunning: true, ...over,
  };
}
function fresh(): void { pref = null; puts.length = 0; stops.length = 0; busyInstances = new Set(); }

// ── tests ────────────────────────────────────────────────────────────────

test('the dialog is centred over the global reset and is a labelled modal', () => {
  const cs = dom.getComputedStyle(dlg as never);
  assert.equal(cs.position, 'fixed');
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    assert.equal(cs.getPropertyValue(`margin-${side}`), 'auto', `margin-${side} wins over the reset`);
  }
  assert.match(styles, /#aura-last-window \{[^}]*\binset:\s*0;/);
  assert.equal(dlg.getAttribute('aria-modal'), 'true');
  assert.equal(dlg.getAttribute('aria-labelledby'), 'aura-last-window-title');
  assert.match(markup, /This was the last window of <strong id="aura-last-window-app"><\/strong>\. Stop the process or keep it running\?/);
  assert.match(markup, /Remember for this app/);
  // The shell mounts it on the desktop, outside every app frame.
  assert.match(read('../src/layouts/OSLayout.astro'), /<LastWindowDialog \/>/);
});

test('the last window of a background app asks; focus on Keep running; Esc keeps it running', async () => {
  fresh();
  const done = afterUserClose({ close: lastClose(), manifest: BG });
  await until(() => dlg.open, 'dialog open');
  assert.equal($('aura-last-window-app').textContent, 'Background App');
  assert.equal(focused(), keep, 'the safe answer has the focus');
  assert.equal(remember.checked, false);
  assert.equal(key('Escape'), true);
  assert.equal(await done, 'kept');
  assert.equal(dlg.open, false);
  assert.deepEqual(stops, []);
  assert.deepEqual(puts, [], 'nothing remembered without the checkbox');
});

test('Tab cycles inside the dialog only; arrows move between the answers; Enter answers the focused one', async () => {
  fresh();
  const done = afterUserClose({ close: lastClose(), manifest: BG });
  await until(() => dlg.open, 'dialog open');
  assert.equal(key('Tab'), true); assert.equal(focused(), stopBtn);
  assert.equal(key('Tab'), true); assert.equal(focused(), remember, 'wraps around');
  assert.equal(key('Tab', { shiftKey: true }), true); assert.equal(focused(), stopBtn);
  assert.equal(key('ArrowLeft'), true); assert.equal(focused(), keep);
  assert.equal(key('ArrowRight'), true); assert.equal(focused(), stopBtn);
  assert.equal(key('ArrowDown'), true); assert.equal(focused(), stopBtn, 'no wrap');
  assert.equal(key('Enter', { repeat: true }), true);
  assert.equal(dlg.open, true, 'a held Enter (from the close) answers nothing');
  keep.focus();
  assert.equal(key('Enter'), true);
  assert.equal(await done, 'kept');
});

test('Stop with "Remember for this app": the lifecycle stop, and the choice is kept per installation', async () => {
  fresh();
  const close = lastClose({ installationId: 'inst_1' });
  const done = afterUserClose({ close, manifest: BG });
  await until(() => dlg.open, 'dialog open');
  remember.focus();
  assert.equal(key('Enter'), true, 'Enter on the checkbox toggles it');
  assert.equal(remember.checked, true);
  stopBtn.click();
  assert.equal(await done, 'stopped');
  assert.deepEqual(stops, [close.parentInstanceId]);
  const saved = pref as { ask: boolean; apps: Record<string, { choice: string; appId: string; name?: string }> };
  assert.equal(saved.ask, true);
  assert.deepEqual(Object.keys(saved.apps), ['inst_1']);
  assert.equal(saved.apps['inst_1']!.choice, 'stop');
  assert.equal(saved.apps['inst_1']!.appId, 'io.bg.app');
  assert.equal(saved.apps['inst_1']!.name, 'Background App');

  // The next last window of that installation: no question, it stops.
  const next = lastClose({ installationId: 'inst_1' });
  assert.equal(await afterUserClose({ close: next, manifest: BG }), 'stopped');
  assert.equal(dlg.open, false);
  assert.deepEqual(stops, [close.parentInstanceId, next.parentInstanceId]);
});

test('a remembered Keep running: no question, nothing stopped', async () => {
  fresh();
  pref = { ask: true, apps: { 'io.bg.app': { choice: 'keep', appId: 'io.bg.app', at: 1 } } };
  assert.equal(await afterUserClose({ close: lastClose(), manifest: BG }), 'kept');
  assert.equal(dlg.open, false);
  assert.deepEqual(stops, []);
});

test('Stop does not take down a window opened meanwhile (not idle)', async () => {
  fresh();
  const close = lastClose();
  busyInstances.add(close.parentInstanceId);
  const done = afterUserClose({ close, manifest: BG });
  await until(() => dlg.open, 'dialog open');
  stopBtn.click();
  assert.equal(await done, 'stop-skipped');
  assert.deepEqual(stops, []);
});

test('the switch off: no question, the process keeps running', async () => {
  fresh();
  pref = { ask: false, apps: {} };
  assert.equal(await afterUserClose({ close: lastClose(), manifest: BG }), 'none');
  assert.equal(dlg.open, false);
  assert.deepEqual(stops, []);
});

test('never asked: not the last window, an app without a background process, a service, an auto-stopped instance', async () => {
  fresh();
  assert.equal(await afterUserClose({ close: lastClose({ lastOfInstance: false }), manifest: BG }), 'none');
  assert.equal(await afterUserClose({ close: lastClose(), manifest: { ...BG, backgroundService: false } }), 'none');
  assert.equal(await afterUserClose({ close: lastClose(), manifest: { ...BG, componentType: 'service' } }), 'none');
  assert.equal(await afterUserClose({ close: lastClose({ instanceStopped: true, instanceRunning: false }), manifest: { ...BG, backgroundService: false } }), 'none');
  assert.equal(await afterUserClose({ close: null, manifest: BG }), 'none');
  assert.equal(dlg.open, false);
  assert.deepEqual(stops, []);
});

test('without a manifest at hand (a flight close) the app\'s own is read', async () => {
  fresh();
  const done = afterUserClose({ close: lastClose(), manifest: null });
  await until(() => dlg.open, 'dialog open');
  assert.equal($('aura-last-window-app').textContent, 'Background App');
  keep.click();
  assert.equal(await done, 'kept');
});

test('two last windows at once: one question after the other; the browser\'s close request is Keep running', async () => {
  fresh();
  const a = afterUserClose({ close: lastClose(), manifest: BG });
  const b = afterUserClose({ close: lastClose(), manifest: { ...BG, name: 'Second' } });
  await until(() => dlg.open, 'first open');
  assert.equal($('aura-last-window-app').textContent, 'Background App');
  dlg.dispatchEvent(new dom.Event('cancel', { cancelable: true }) as unknown as Event);
  assert.equal(await a, 'kept');
  await until(() => dlg.open && $('aura-last-window-app').textContent === 'Second', 'second open');
  assert.equal(focused(), keep);
  stopBtn.click();
  assert.equal(await b, 'stopped');
  assert.equal(stops.length, 1);
});
