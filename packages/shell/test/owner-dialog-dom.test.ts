/**
 * The owner dialog (components/shell/OwnerPasswordDialog.astro +
 * lib/approvals/ownerDialog.ts) in happy-dom: centred styles, focus on open,
 * the Tab trap, arrows between the answers, Enter, Esc = Deny/Cancel, and an
 * Approve that stays inert for APPROVE_DELAY_MS and never has the first focus.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dom } from './dom.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const astro = read('../src/components/shell/OwnerPasswordDialog.astro');
const markup = astro.match(/<dialog[\s\S]*?<\/dialog>/)![0];
const styles = astro.match(/<style is:global>([\s\S]*?)<\/style>/)![1]!;
// The shell's global reset (`* { margin: 0 }`) is what once pinned the dialog to the top left.
const reset = read('../src/styles/global.css').replace(/@import[^;]+;/g, '');

dom.happyDOM.setURL('https://aura-shell.test/');
Object.defineProperty(globalThis, 'location', { get: () => dom.location, configurable: true });
dom.document.head.innerHTML = `<style>${reset}</style><style>${styles}</style>`;
dom.document.body.innerHTML = markup;

// ── the server, in memory ──────────────────────────────────────────────────

type View = Record<string, unknown> & { id: string; state: string };
const views = new Map<string, View>();
const decisions: Array<{ id: string; decision: string; body: Record<string, unknown> }> = [];
let release: ((list: View[]) => void) | null = null;
let version = 1;
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
  const url = new URL(String(input), 'https://aura-shell.test');
  const path = url.pathname;
  if (path === '/api/auth/password-policy') return json({ policy: { minLength: 8, requiredClasses: 0, differFromUsername: false } });
  if (path === '/api/approvals') {
    // The long poll: the first answer is the empty list, the next waits for the test.
    if (!url.searchParams.has('seen')) return json({ version, pending: [] });
    const list = await new Promise<View[]>((r) => { release = r; });
    return json({ version: ++version, pending: list });
  }
  const m = path.match(/^\/api\/approvals\/([^/]+)(?:\/(approve|deny))?$/);
  if (m) {
    const view = views.get(decodeURIComponent(m[1]!));
    if (!view) return json({ error: 'not-found' }, 404);
    if (init?.method === 'POST') {
      decisions.push({ id: view.id, decision: m[2]!, body: JSON.parse(init.body ?? '{}') });
      view.state = m[2] === 'approve' ? 'approved' : 'denied';
      return json({ ok: true });
    }
    return json(view);
  }
  return json({ error: 'not-found' }, 404);
}) as typeof fetch;

const { initOwnerDialog } = await import('../src/lib/approvals/ownerDialog.ts');
const { APPROVE_DELAY_MS } = await import('../src/lib/approvals/dialogClient.ts');
initOwnerDialog();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => dom.document.getElementById(id) as unknown as T;
const dlg = $<HTMLDialogElement>('aura-owner-password');
const current = $<HTMLInputElement>('aura-owner-password-current');
const cancel = $<HTMLButtonElement>('aura-owner-password-cancel');
const block = $<HTMLButtonElement>('aura-owner-password-block');
const approve = $<HTMLButtonElement>('aura-owner-password-submit');
const focused = () => dom.document.activeElement as unknown as HTMLElement | null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(5);
  }
}

/** A key on the focused element; true when the dialog took it (default prevented). */
function key(k: string, opts: { shiftKey?: boolean; repeat?: boolean } = {}): boolean {
  const target = (dom.document.activeElement ?? dom.document.body) as unknown as EventTarget;
  const ev = new dom.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts });
  target.dispatchEvent(ev as unknown as Event);
  return ev.defaultPrevented;
}

let n = 0;
function approval(over: Record<string, unknown> = {}): View {
  const id = `apr_${String(++n).padStart(22, 'A')}`;
  const view: View = {
    id, action: 'apps.install', level: 'session', state: 'pending', expiresAt: Date.now() + 60_000,
    display: { title: 'INSTALL AN APP', details: ['com.example.notes'], requestedBy: 'Terminal agent' },
    appId: null, blockable: null, ...over,
  };
  views.set(id, view);
  return view;
}

/** Hand the poll a pending list and wait until the dialog shows it. */
async function serve(view: View): Promise<void> {
  await until(() => !!release, 'poll waiting');
  const r = release!;
  release = null;
  r([view]);
  await until(() => dlg.open, 'dialog open');
}

async function closed(): Promise<void> {
  await until(() => !dlg.open, 'dialog closed');
}

// ── an app window, as the shell knows it (lib/appFrame.ts data attributes) ──

const APP_ORIGIN = 'https://notes1a2b3c4d--aura-shell.test';
const posts: unknown[] = [];
const appWindow = { postMessage: (m: unknown) => posts.push(m), parent: dom, closed: false };
{
  const slot = dom.document.createElement('div');
  slot.className = 'app-slot';
  const f = dom.document.createElement('iframe');
  Object.assign(f.dataset, { auraHostFrame: '1', auraAppId: 'com.example.notes', auraFrameOrigin: APP_ORIGIN });
  Object.defineProperty(f, 'contentWindow', { value: appWindow });
  slot.appendChild(f);
  dom.document.body.appendChild(slot);
}
function fromApp(data: Record<string, unknown>): void {
  dom.dispatchEvent(new dom.MessageEvent('message', { data, origin: APP_ORIGIN, source: appWindow as never }));
}

// ── tests ────────────────────────────────────────────────────────────────

test('the dialog is centred over the global reset, scrolls inside when short, and is a labelled modal', () => {
  const cs = dom.getComputedStyle(dlg as never);
  assert.equal(cs.position, 'fixed');
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    assert.equal(cs.getPropertyValue(`margin-${side}`), 'auto', `margin-${side} wins over the reset`);
  }
  assert.equal(cs.overflowY, 'auto');
  assert.match(styles, /#aura-owner-password \{[^}]*\binset:\s*0;/);
  assert.match(styles, /max-height:\s*calc\(100dvh - 32px\)/);
  assert.match(styles, /width:\s*min\(460px, calc\(100vw - 32px\)\)/);
  assert.match(styles, /:is\(button, input\):focus\s*\{\s*outline:\s*2px solid/);
  assert.equal(dlg.getAttribute('role'), 'dialog');
  assert.equal(dlg.getAttribute('aria-modal'), 'true');
  assert.equal(dlg.getAttribute('aria-labelledby'), 'aura-owner-password-title');
});

test('an approval opens focused on Deny, with Approve inert; Esc denies', async () => {
  const view = approval();
  await serve(view);
  assert.equal(focused(), cancel, 'Deny has the first focus');
  assert.equal(approve.disabled, true);
  assert.notEqual(focused(), approve);
  // Before the delay: neither Enter nor a click on Approve nor an arrow to it approves.
  approve.click();
  assert.equal(key('ArrowRight'), true);
  assert.equal(focused(), cancel, 'a disabled Approve cannot take focus');
  approve.focus();
  assert.equal(focused(), cancel, 'nor can a script focus it');
  await sleep(20);
  assert.equal(decisions.length, 0, 'nothing decided before the delay');
  assert.equal(key('Escape'), true, 'Esc is taken, not left to the browser');
  await closed();
  assert.deepEqual(decisions.splice(0).map((d) => [d.id, d.decision]), [[view.id, 'deny']]);
});

test('Tab and Shift+Tab cycle inside the dialog; arrows move between the answers', async () => {
  const view = approval({ blockable: 'com.example.notes' });
  await serve(view);
  assert.equal(focused(), cancel);
  key('Tab');
  assert.equal(focused(), block, 'Approve is still disabled: Tab wraps to the first control');
  key('Tab', { shiftKey: true });
  assert.equal(focused(), cancel);
  await until(() => !approve.disabled, 'approve wakes', APPROVE_DELAY_MS + 500);
  assert.equal(focused(), cancel, 'waking does not move the focus');
  key('Tab');
  assert.equal(focused(), approve);
  key('Tab');
  assert.equal(focused(), block, 'from the last control back to the first');
  key('Tab', { shiftKey: true });
  assert.equal(focused(), approve, 'and backwards');
  key('ArrowLeft');
  assert.equal(focused(), cancel);
  key('ArrowUp');
  assert.equal(focused(), block);
  key('ArrowLeft');
  assert.equal(focused(), block, 'no wrap');
  key('ArrowDown');
  key('ArrowRight');
  assert.equal(focused(), approve);
  key('Escape');
  await closed();
  assert.deepEqual(decisions.splice(0).map((d) => d.decision), ['deny'], 'Esc denies even with Approve focused');
});

test('Approve only by an explicit move to it plus Enter after the delay', async () => {
  const view = approval();
  await serve(view);
  await until(() => !approve.disabled, 'approve wakes', APPROVE_DELAY_MS + 500);
  key('Enter', { repeat: true });
  await sleep(20);
  assert.equal(dlg.open, true, 'a held Enter answers nothing');
  key('ArrowRight');
  assert.equal(focused(), approve);
  key('Enter');
  await closed();
  assert.deepEqual(decisions.splice(0).map((d) => [d.id, d.decision]), [[view.id, 'approve']]);
});

test('Enter on the focused Deny denies', async () => {
  const view = approval();
  await serve(view);
  assert.equal(key('Enter'), true);
  await closed();
  assert.deepEqual(decisions.splice(0).map((d) => [d.id, d.decision]), [[view.id, 'deny']]);
});

test('a fresh approval focuses the password; Enter there waits for the delay; Esc denies', async () => {
  const view = approval({ level: 'fresh' });
  await serve(view);
  assert.equal(focused(), current);
  current.value = 'pw';
  key('Enter');
  await sleep(20);
  assert.equal(decisions.length, 0, 'Enter in the field cannot approve before the delay');
  await until(() => !approve.disabled, 'approve wakes', APPROVE_DELAY_MS + 500);
  current.focus();
  key('Escape');
  await closed();
  assert.deepEqual(decisions.splice(0).map((d) => [d.decision, d.body['password']]), [['deny', undefined]], 'Esc denies, no password sent');
});

test('an app\'s confirm answered with Esc gets back {confirmed: false} only', async () => {
  const view = approval({ action: 'user.confirm', appId: 'com.example.notes', display: { title: 'CONFIRM', details: [], requestedBy: 'Notes' } });
  fromApp({ type: 'aura.user.confirm.request', requestId: 'r1', approvalId: view.id });
  await until(() => dlg.open, 'dialog open');
  assert.equal(focused(), cancel);
  key('Escape');
  await closed();
  assert.deepEqual(posts.splice(0), [{ type: 'aura.user.confirm.result', requestId: 'r1', confirmed: false }]);
  assert.deepEqual(decisions.splice(0).map((d) => d.decision), ['deny']);
});

test('the browser\'s own close request denies too, never approves', async () => {
  const view = approval();
  await serve(view);
  dlg.dispatchEvent(new dom.Event('cancel', { cancelable: true }) as unknown as Event);
  await closed();
  assert.deepEqual(decisions.splice(0).map((d) => [d.id, d.decision]), [[view.id, 'deny']]);
});

test('a close the browser does on its own (no cancel event) ends the approval as a deny', async () => {
  const view = approval();
  await serve(view);
  dlg.close();
  await until(() => decisions.length > 0, 'decided');
  assert.deepEqual(decisions.splice(0).map((d) => [d.id, d.decision]), [[view.id, 'deny']]);
});

test('the password dialog: focus on the field, Enter submits there, Esc cancels', async () => {
  const settings = dom.document.createElement('iframe');
  const settingsOrigin = 'https://settings1a2b3c4d--aura-shell.test';
  const settingsPosts: unknown[] = [];
  const settingsWindow = { postMessage: (m: unknown) => settingsPosts.push(m), parent: dom, closed: false };
  Object.assign(settings.dataset, { auraHostFrame: '1', auraAppId: 'com.aura.settings', auraFrameOrigin: settingsOrigin, auraSystemApp: '1' });
  Object.defineProperty(settings, 'contentWindow', { value: settingsWindow });
  dom.document.querySelector('.app-slot')!.appendChild(settings);
  dom.dispatchEvent(new dom.MessageEvent('message', {
    data: { type: 'aura.account.password.request', requestId: 'p1' }, origin: settingsOrigin, source: settingsWindow as never,
  }));
  await until(() => dlg.open, 'dialog open');
  assert.equal(focused(), current);
  key('Enter');
  assert.equal($('aura-owner-password-error').textContent, 'Enter your current password.', 'Enter in a field is the primary action');
  key('Tab', { shiftKey: true });
  assert.equal(focused(), approve, 'Shift+Tab from the first field wraps to the last button');
  key('Escape');
  await closed();
  assert.deepEqual(settingsPosts, [{ type: 'aura.account.password.result', requestId: 'p1', ok: false, error: 'cancelled' }]);
});
