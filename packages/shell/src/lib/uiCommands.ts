/**
 * Browser half of the shell's UI command channel (server half:
 * lib/uiCommandBroker.ts). A server-side caller — the Aura Shell Daemon's
 * MCP — POSTs /api/os/ui/command; the shell emits it as a `ui:command`
 * event; THIS tab claims it, runs the registered handler, and posts the
 * answer back.
 *
 * Handlers are registered by the component that owns the function: the
 * desktop registers window and workspace commands, the status bar zoom and
 * fullscreen, the launcher and process manager their own panels. The
 * registry lives on `window` because those are separate island scripts
 * with separate module instances (the same reason osEvents is pinned there).
 *
 * `snapshot` is the one command implemented here: every component
 * registers a "part", and the snapshot is the merge — that is what gives the
 * MCP a one-call picture of state that only exists in this page.
 */
import { osEvents } from './osEvents.ts';

export type UiCommandParams  = Record<string, unknown>;
export type UiCommandHandler = (params: UiCommandParams) => unknown | Promise<unknown>;

interface Registry {
  handlers: Map<string, UiCommandHandler>;
  parts: Map<string, () => unknown>;
  started: boolean;
}

const KEY = '__auraUiCommands';

function registry(): Registry {
  const w = window as unknown as Record<string, Registry | undefined>;
  return (w[KEY] ??= { handlers: new Map(), parts: new Map(), started: false });
}

export function registerUiCommand(action: string, handler: UiCommandHandler): void {
  registry().handlers.set(action, handler);
}

export function registerSnapshotPart(name: string, fn: () => unknown): void {
  registry().parts.set(name, fn);
}

/** Every registered part, each one guarded: one broken part must not blind the rest. */
export function snapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, fn] of registry().parts) {
    try { out[name] = fn(); }
    catch (err) { out[name] = { error: err instanceof Error ? err.message : String(err) }; }
  }
  return out;
}

/** Run a registered handler in this tab, bypassing the broker — for the
 *  `aura.system.*` postMessage path, which is a second front door onto the
 *  same table. */
export async function invokeLocal(action: string, params: UiCommandParams = {}): Promise<unknown> {
  const h = registry().handlers.get(action);
  if (!h) throw new Error(`no UI command "${action}" is registered in this page`);
  return h(params);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function post(path: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch { return null; }
}

async function handle(ev: { id?: unknown; action?: unknown; params?: unknown }): Promise<void> {
  const { id, action } = ev;
  if (typeof id !== 'string' || typeof action !== 'string') return;
  const r = registry();
  // Never claim what this tab cannot serve — another tab may be able to.
  if (action !== 'snapshot' && !r.handlers.has(action)) return;
  // The tab the user is looking at should win the claim; a hidden tab only
  // steps in when no visible one has answered.
  if (document.visibilityState !== 'visible') await sleep(300);
  const claim = await post('/api/os/ui/claim', { id });
  if (!claim || !claim.ok) return;

  const params = (ev.params && typeof ev.params === 'object') ? ev.params as UiCommandParams : {};
  let answer: { id: string; ok: boolean; result?: unknown; error?: string };
  try {
    const result = action === 'snapshot' ? snapshot() : await r.handlers.get(action)!(params);
    answer = { id, ok: true, result: result ?? null };
  } catch (err) {
    answer = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  await post('/api/os/ui/result', answer);
}

/**
 * The user's clock. Built in here rather than in a component: the daemon's
 * container runs on UTC, and "what time is it" means the time on the screen
 * the person is looking at. The zone and locale come from the status-bar
 * clock's data-* (Settings → General, KV os/timeZone + os/locale) when set —
 * the device running this browser may itself sit on UTC — and from the
 * device otherwise.
 */
function clock(): Record<string, unknown> {
  const now = new Date();
  const device = Intl.DateTimeFormat().resolvedOptions();
  const prefs = document.getElementById('clock')?.dataset ?? {};
  const setZone = prefs['timeZone'] || '';
  const locale = prefs['locale'] || device.locale;
  let timeZone = setZone || device.timeZone;
  let fmt: Intl.DateTimeFormat;
  try { fmt = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'shortOffset' }); }
  catch { timeZone = device.timeZone; fmt = new Intl.DateTimeFormat(device.locale, { timeZone, timeZoneName: 'shortOffset' }); }
  // Offset of THAT zone, from its formatted "GMT+2"-style name; the device's
  // getTimezoneOffset would be wrong when a zone is set.
  const offsetName = fmt.formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /([+-])(\d{1,2})(?::?(\d{2}))?/.exec(offsetName);
  const utcOffsetMinutes = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  return {
    iso: now.toISOString(),
    epochMs: now.getTime(),
    local: now.toLocaleString(locale, { dateStyle: 'full', timeStyle: 'short', timeZone, hour12: prefs['clockFormat'] === '12h' }),
    date: now.toLocaleDateString(locale, { dateStyle: 'full', timeZone }),
    time: now.toLocaleTimeString(locale, { timeStyle: 'short', timeZone, hour12: prefs['clockFormat'] === '12h' }),
    timeZone,
    utcOffsetMinutes,
    locale,
    zoneSource: setZone ? 'AuraOS setting (Settings → General)' : 'the browser\'s device',
    deviceTimeZone: device.timeZone,
  };
}

/** Subscribe once per page; safe to call from any island. */
export function startUiCommandListener(): void {
  const r = registry();
  if (r.started) return;
  r.started = true;
  r.handlers.set('clock', clock);
  osEvents.subscribe(['ui:command'], (ev) => { void handle(ev as { id?: unknown; action?: unknown; params?: unknown }); });
}
