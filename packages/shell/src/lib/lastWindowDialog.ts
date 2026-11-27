/**
 * The last-window dialog (D101), browser side: the behaviour of
 * components/shell/LastWindowDialog.astro, which holds the markup and the
 * styles. The decision and the preference are lib/lastWindow.ts.
 *
 * The desktop calls `afterUserClose` with the server's answer to a USER close
 * of a window (POST /api/activities/<id>/close) or a flight (…/flight/close).
 * Closes by an agent or the CLI never ask (they have no one to ask). The
 * dialog belongs to the shell, never to the app: the app's frame cannot open,
 * answer or style it.
 *
 * Keyboard (like the owner dialog, lib/approvals/ownerDialog.ts):
 *   - on open, focus goes to Keep running (the safe answer);
 *   - Tab and Shift+Tab cycle through the dialog's own controls only;
 *   - ←/→ and ↑/↓ move between the answer buttons;
 *   - Enter activates the focused button (on the checkbox it toggles it);
 *   - Esc (and the browser's own close request) is Keep running: nothing is lost.
 *
 * "Stop" is the normal lifecycle stop (`onStop` reason `user`), and only while
 * the instance still has no window (`?ifIdle=1`): a window opened while the
 * dialog was up keeps its process.
 */
import {
  LAST_WINDOW_EVENT, LAST_WINDOW_PREF, choiceKey, decideLastWindow, normalizeLastWindowPrefs, rememberChoice,
  type CloseFacts, type LastWindowChoice, type LastWindowPrefs, type ProcessShape,
} from './lastWindow.ts';

export interface LastWindowQuestion {
  appId: string;
  appName: string;
  instanceId: string;
}

export interface LastWindowAnswer {
  choice: LastWindowChoice;
  remember: boolean;
}

/** What `afterUserClose` ended with (for the caller's log and the tests). */
export type LastWindowOutcome = 'none' | 'kept' | 'stopped' | 'stop-skipped';

const PREF_URL = `/api/kv/os/${LAST_WINDOW_PREF}`;
const ARROW_STEP: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };

// ── the preference ─────────────────────────────────────────────────────────

export async function loadLastWindowPrefs(): Promise<LastWindowPrefs> {
  try {
    const r = await fetch(PREF_URL, { credentials: 'same-origin' });
    if (!r.ok) return normalizeLastWindowPrefs(null);
    return normalizeLastWindowPrefs(((await r.json()) as { value?: unknown }).value);
  } catch {
    return normalizeLastWindowPrefs(null);
  }
}

async function saveLastWindowPrefs(prefs: LastWindowPrefs): Promise<void> {
  try {
    const r = await fetch(PREF_URL, {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: prefs }),
    });
    if (r.ok) window.dispatchEvent(new CustomEvent(LAST_WINDOW_EVENT, { detail: prefs }));
  } catch { /* the choice is not remembered; the next close asks again */ }
}

/** The app's manifest, when the caller has none at hand (the flight layer). */
async function fetchManifest(appId: string): Promise<(ProcessShape & { name?: string }) | null> {
  try {
    const r = await fetch(`/api/apps/${encodeURIComponent(appId)}/status`, { credentials: 'same-origin' });
    return r.ok ? ((await r.json()) as { manifest?: ProcessShape & { name?: string } }).manifest ?? null : null;
  } catch {
    return null;
  }
}

/** Stop the instance with the normal lifecycle, but only while it has no window. */
async function stopIfIdle(instanceId: string): Promise<boolean> {
  try {
    const r = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/stop?ifIdle=1`, { method: 'POST', credentials: 'same-origin' });
    return r.ok;
  } catch {
    return false;
  }
}

// ── the dialog ─────────────────────────────────────────────────────────────

interface Asked { q: LastWindowQuestion; resolve: (a: LastWindowAnswer) => void }
const queue: Asked[] = [];
let current: Asked | null = null;
/** Whether the last close was ours; any other close (the browser's) is Keep running. */
let closedByUs = false;

function els() {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const dlg = $<HTMLDialogElement>('aura-last-window');
  const app = $('aura-last-window-app');
  const remember = $<HTMLInputElement>('aura-last-window-remember');
  const keep = $<HTMLButtonElement>('aura-last-window-keep');
  const stop = $<HTMLButtonElement>('aura-last-window-stop');
  return dlg && app && remember && keep && stop ? { dlg, app, remember, keep, stop } : null;
}

/** Whether this document has the dialog (the desktop does; other shell pages do not). */
export function hasLastWindowDialog(): boolean {
  return els() !== null;
}

let wired = false;
function wire(): void {
  const e = els();
  if (!e || wired) return;
  wired = true;
  e.keep.addEventListener('click', () => answer('keep'));
  e.stop.addEventListener('click', () => answer('stop'));
  // The browser's close request (Android back, a CloseWatcher) is Esc: keep running.
  e.dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); answer('keep'); });
  e.dlg.addEventListener('close', () => {
    if (closedByUs) { closedByUs = false; return; }
    if (current && !e.dlg.open) answer('keep');
  });
  // Before the shell's own shortcuts; the open modal makes everything else inert.
  window.addEventListener('keydown', onKey, { capture: true });
}

function onKey(ev: KeyboardEvent): void {
  const e = els();
  if (!e?.dlg.open || !current || ev.isComposing) return;
  const at = document.activeElement as HTMLElement | null;
  const inside = !!at && e.dlg.contains(at);
  const handled = () => { ev.preventDefault(); ev.stopPropagation(); };
  if (ev.key === 'Escape') { handled(); answer('keep'); return; }
  if (ev.key === 'Tab') {
    handled();
    const list: HTMLElement[] = [e.remember, e.keep, e.stop];
    const i = inside ? list.indexOf(at!) : -1;
    const step = ev.shiftKey ? -1 : 1;
    list[i < 0 ? (step > 0 ? 0 : list.length - 1) : (i + step + list.length) % list.length]!.focus();
    return;
  }
  const step = ARROW_STEP[ev.key];
  if (step && (at === e.keep || at === e.stop)) {
    handled();
    (step > 0 ? e.stop : e.keep).focus();
    return;
  }
  if (ev.key === 'Enter' && inside && !ev.altKey && !ev.ctrlKey && !ev.metaKey) {
    handled();
    // A held Enter from the close that opened the dialog answers nothing.
    if (ev.repeat) return;
    if (at === e.remember) e.remember.checked = !e.remember.checked;
    else if (at === e.keep || at === e.stop) (at as HTMLButtonElement).click();
  }
}

function answer(choice: LastWindowChoice): void {
  const e = els();
  const asked = current;
  if (!asked) return;
  current = null;
  const remember = !!e?.remember.checked;
  if (e?.dlg.open) { closedByUs = true; e.dlg.close(); }
  asked.resolve({ choice, remember });
  pump();
}

function pump(): void {
  if (current) return;
  const e = els();
  const next = queue.shift();
  if (!next) return;
  if (!e) { next.resolve({ choice: 'keep', remember: false }); pump(); return; }
  current = next;
  e.app.textContent = next.q.appName;
  e.remember.checked = false;
  e.dlg.dataset['appId'] = next.q.appId;
  if (!e.dlg.open) e.dlg.showModal();
  e.keep.focus();
}

/** Ask the user (queued: one dialog at a time). Without the dialog in this document: keep running. */
export function askLastWindow(q: LastWindowQuestion): Promise<LastWindowAnswer> {
  wire();
  return new Promise((resolve) => {
    queue.push({ q, resolve });
    pump();
  });
}

// ── the flow ───────────────────────────────────────────────────────────────

export interface UserCloseInput {
  /** The server's answer (`close` of POST …/close or …/flight/close). */
  close: (CloseFacts & { parentInstanceId?: string | null }) | null | undefined;
  manifest: (ProcessShape & { name?: string }) | null | undefined;
}

/**
 * After a user closed a window: ask (or apply the remembered choice) when it
 * was the last window of an instance whose background process keeps running.
 */
export async function afterUserClose({ close, manifest }: UserCloseInput): Promise<LastWindowOutcome> {
  if (!close?.closed || !close.lastOfInstance || !close.instanceRunning || !close.appId || !close.parentInstanceId) return 'none';
  if (!hasLastWindowDialog()) return 'none';
  manifest ??= await fetchManifest(close.appId);
  const decision = decideLastWindow(close, manifest, await loadLastWindowPrefs());
  if (decision === 'none') return 'none';
  const instanceId = close.parentInstanceId;
  let choice: LastWindowChoice;
  if (decision === 'ask') {
    const a = await askLastWindow({ appId: close.appId, appName: manifest?.name || close.appId, instanceId });
    choice = a.choice;
    if (a.remember) {
      // Re-read first: Settings (or another tab) may have changed it meanwhile.
      const fresh = await loadLastWindowPrefs();
      await saveLastWindowPrefs(rememberChoice(fresh, choiceKey(close.appId, close.installationId), {
        choice, appId: close.appId, ...(manifest?.name ? { name: manifest.name } : {}),
      }));
    }
  } else {
    choice = decision;
  }
  if (choice === 'keep') return 'kept';
  return (await stopIfIdle(instanceId)) ? 'stopped' : 'stop-skipped';
}
