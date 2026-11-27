/**
 * D101: Settings → Apps → Activities & processes (apps/com.aura.settings
 * src/scripts/activitiesProcesses.ts + the section in src/pages/apps.astro)
 * in happy-dom: the switch, the remembered choices and their reset, all on
 * the user's own `os/lastWindow`, in the format the shell reads
 * (lib/lastWindow.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dom, flush } from './dom.ts';
import { normalizeLastWindowPrefs, decideLastWindow } from '../src/lib/lastWindow.ts';

const SETTINGS = '../../../apps/com.aura.settings/';
const read = (rel: string) => readFileSync(new URL(SETTINGS + rel, import.meta.url), 'utf8');
const page = read('src/pages/apps.astro');
// The section's markup, without its Astro expressions.
const section = page.match(/<section class="acc-section" id="lw-section"[\s\S]*?<\/section>/)![0]
  .replace(/<Icon[^>]*\/>/g, '')
  .replace(/aria-checked=\{[^}]*\}/, 'aria-checked="true"')
  .replace(/data-on=\{[^}]*\}/, 'data-on="true"')
  .replace(/<script type="application\/json"[\s\S]*?<\/script>/, '');

let stored: unknown = null;
const puts: unknown[] = [];
const urls: string[] = [];
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'Content-Type': 'application/json' } });
const fakeFetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
  urls.push(String(input));
  if (init?.method === 'PUT') { stored = JSON.parse(init.body!).value; puts.push(stored); return json({ value: stored }); }
  return stored === null ? json({ error: 'No value' }, 404) : json({ value: stored, updatedAt: 1 });
}) as typeof fetch;

const { initActivitiesProcesses, readDoc, PREF_PATH } = await import(`${SETTINGS}src/scripts/activitiesProcesses.ts`);

function mount(names: Record<string, string> = {}) {
  dom.document.body.innerHTML = `<main>${section}<p id="status"></p></main>`;
  const root = dom.document.getElementById('lw-section') as unknown as HTMLElement;
  const statuses: string[] = [];
  const ctl = initActivitiesProcesses({ root, url: (p: string) => `/gw${p}`, fetch: fakeFetch, names, status: (m: string) => statuses.push(m) });
  const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as unknown as T;
  return { root, ctl, statuses, q, rows: () => Array.from(root.querySelectorAll('.lw-item')) as unknown as HTMLElement[] };
}
async function settle(): Promise<void> { for (let i = 0; i < 5; i++) await flush(); }

test('the section lives on the Apps page under the owner\'s wording, and the tile says so', () => {
  assert.match(page, /Activities &amp; processes/);
  assert.match(read('src/pages/index.astro'), /activities &amp; processes/);
  assert.match(page, /role="switch"/);
  assert.equal(PREF_PATH, '/api/kv/os/lastWindow');
  // Settings writes the topic like its other os/<topic> keys.
  assert.ok(JSON.parse(read('app.manifest.json')).permissions.includes('system.kv.os.lastWindow.write'));
});

test('nothing stored yet: the switch is on, no remembered choice', async () => {
  stored = null;
  const s = mount();
  await s.ctl.refresh();
  assert.equal(s.q('#lw-ask').getAttribute('aria-checked'), 'true');
  assert.equal(s.rows().length, 0);
  assert.equal(s.q('#lw-empty').hidden, false);
  assert.equal(s.q('#lw-reset-all').hidden, true);
  assert.ok(urls.at(-1)!.startsWith('/gw/api/kv/os/lastWindow'), 'through the gateway, as the user');
});

test('the switch turns the question off and on (read-modify-write, the shell reads the same document)', async () => {
  stored = { ask: true, apps: { inst_1: { choice: 'stop', appId: 'io.bg.app', name: 'Bg', at: 1 } } };
  puts.length = 0;
  const s = mount();
  await s.ctl.refresh();
  s.q<HTMLButtonElement>('#lw-ask').click();
  await settle();
  assert.equal(s.q('#lw-ask').getAttribute('aria-checked'), 'false');
  assert.equal(s.q('#lw-ask').dataset['on'], 'false');
  assert.deepEqual(puts.at(-1), { ask: false, apps: { inst_1: { choice: 'stop', appId: 'io.bg.app', name: 'Bg', at: 1 } } }, 'the choices stay');
  const shellView = normalizeLastWindowPrefs(stored);
  const close = { closed: true, lastOfInstance: true, instanceStopped: false, instanceRunning: true, appId: 'io.other' };
  assert.equal(decideLastWindow(close, { backgroundService: true }, shellView), 'none', 'the shell no longer asks');
  s.q<HTMLButtonElement>('#lw-ask').click();
  await settle();
  assert.equal((stored as { ask: boolean }).ask, true);
});

test('remembered choices are listed with their app and choice, and each resets', async () => {
  stored = {
    ask: true,
    apps: {
      inst_1: { choice: 'stop', appId: 'io.bg.app', name: 'Old Name', at: 1 },
      'io.term': { choice: 'keep', appId: 'io.term', at: 2 },
    },
  };
  const s = mount({ 'io.bg.app': 'Background App' });
  await s.ctl.refresh();
  const rows = s.rows();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.querySelector('.lw-item-name')!.textContent), ['Background App', 'io.term'], 'the installed app\'s name wins; sorted');
  assert.deepEqual(rows.map((r) => r.querySelector('.pill')!.textContent), ['STOP', 'KEEP RUNNING']);
  assert.equal(s.q('#lw-empty').hidden, true);
  // Reset one: that app asks again.
  (rows[0]!.querySelector('.lw-reset') as unknown as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(Object.keys((stored as { apps: object }).apps), ['io.term']);
  assert.equal(s.rows().length, 1);
  // Reset all.
  s.q<HTMLButtonElement>('#lw-reset-all').click();
  await settle();
  assert.deepEqual((stored as { apps: object }).apps, {});
  assert.equal(s.rows().length, 0);
  assert.equal(s.q('#lw-empty').hidden, false);
});

test('a choice the desktop remembered meanwhile is not lost by a Settings change', async () => {
  stored = { ask: true, apps: {} };
  const s = mount();
  await s.ctl.refresh();
  // The desktop's dialog writes while the page is open.
  stored = { ask: true, apps: { inst_7: { choice: 'keep', appId: 'io.x', at: 3 } } };
  s.q<HTMLButtonElement>('#lw-ask').click();
  await settle();
  assert.deepEqual(stored, { ask: false, apps: { inst_7: { choice: 'keep', appId: 'io.x', at: 3 } } });
});

test('Settings and the shell read the document the same way', () => {
  const raw = { ask: 'x', apps: { a: { choice: 'stop', appId: 'a.b', at: 1 }, b: { choice: 'nope', appId: 'c' }, c: { choice: 'keep' } } };
  assert.deepEqual(readDoc(raw), normalizeLastWindowPrefs(raw));
  assert.deepEqual(readDoc(null), normalizeLastWindowPrefs(null));
});
