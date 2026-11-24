/**
 * The one answer to "what does this window load?". Every Activity and Flight
 * open, reload, restart, restore, take-off and landing goes through here: the
 * app's own App Host, entered through a one-time handoff, in a sandboxed frame.
 *
 * A view names what it shows by a logical address, `/api/proxy/<instance>/<path>
 * ?_aura_activity=<id>` (`logicalFrameUrl`): instance, path and activity, in
 * the form saved desktop sessions already hold. No frame ever loads it; the
 * proxy refuses browser documents.
 *
 * Nothing here reads a frame's document or location: those frames are
 * cross-origin, so load state comes from the `load` event only.
 */
import type { ResolvedAppFrame } from '@aura/core';
import {
  AURA_RESERVED_PATHS,
  classifyDesktopHost,
  parseAppHost,
  supportsAppHosts,
} from '@aura/core/host-rules';
import { LAUNCHED_HERE_PARAM, takeLaunchMark } from './launchOrigin.ts';

export interface AppFrameTarget {
  appId: string;
  instanceId: string;
  activityId?: string | null;
  path?: string;
}

/**
 * The sandbox of every App Host frame. Deliberately absent:
 *   allow-top-navigation*           an app must not redirect the desktop;
 *   allow-popups-to-escape-sandbox  an unsandboxed popup could navigate its
 *                                   opener's top window, undoing the above.
 * `allow-same-origin` keeps the app's OWN origin. It is safe only because
 * `assertAppHostOrigin` refuses a frame on the shell's origin.
 */
export const APP_FRAME_SANDBOX = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-modals',
  'allow-popups',
  'allow-downloads',
  'allow-pointer-lock',
  'allow-presentation',
].join(' ');

/**
 * What an App Host frame may use. Each entry defaults to the frame's `src`
 * origin, so a document the app navigates to elsewhere does not inherit it.
 */
export const APP_FRAME_ALLOW = [
  'clipboard-read',
  'clipboard-write',
  'fullscreen',
  'microphone',
  'camera',
  'display-capture',
  'autoplay',
].join('; ');

/** Every frame in the shell that shows an app. */
export const APP_FRAME_SELECTOR = '.app-slot iframe, #focus-frame, #flight-layer iframe.flight-frame, #flight-staging iframe';

const HANDOFF_ROUTE = '/api/app-hosts/handoff';

// ── URLs ─────────────────────────────────────────────────────────────────────

/** A view's logical address. Never loaded: `setAppFrameUrl` resolves it to the App Host. */
export function logicalFrameUrl(t: AppFrameTarget): string {
  const stripped = (t.path ?? '').replace(/^\/+/, '');
  const query = t.activityId ? `?_aura_activity=${encodeURIComponent(t.activityId)}` : '';
  return `/api/proxy/${t.instanceId}/${stripped}${query}`;
}

/** The target a logical URL names, or null for anything else. */
export function parseLogicalFrameUrl(url: string, appId: string): AppFrameTarget | null {
  const m = url.match(/^\/api\/proxy\/([^/?#]+)\/([^?#]*)(?:\?([^#]*))?/);
  if (!m) return null;
  const activityId = new URLSearchParams(m[3] ?? '').get('_aura_activity');
  return { appId, instanceId: m[1]!, path: `/${m[2] ?? ''}`, ...(activityId ? { activityId } : {}) };
}

// ── resolve ──────────────────────────────────────────────────────────────────

/** Whether this address can carry App Hosts. Direct IP and `localhost` can't. */
export function appHostsAvailable(host: string): boolean {
  return supportsAppHosts(classifyDesktopHost(host));
}

/** An app on an address that has no App Hosts (limited IP mode). */
export class AppFrameBlockedError extends Error {
  constructor() {
    super('App Hosts are not available on this address');
    this.name = 'AppFrameBlockedError';
  }
}

/** The exact App Host origin, or an error if it isn't one of THIS desktop's. */
export function assertAppHostOrigin(origin: unknown, shellOrigin: string): { origin: string; label: string } {
  if (typeof origin !== 'string') throw new Error('handoff returned no origin');
  const u = new URL(origin);
  const shell = new URL(shellOrigin);
  const parsed = parseAppHost(u.host);
  if (u.origin !== origin || u.origin === shell.origin || u.protocol !== shell.protocol
    || !parsed || parsed.base !== shell.host.toLowerCase()) {
    throw new Error('handoff returned an origin outside this desktop');
  }
  return { origin: u.origin, label: parsed.name };
}

/** Whether `origin` is an App Host of the desktop at `shellOrigin`. */
export function isAppHostOriginOf(origin: string, shellOrigin: string): boolean {
  try { assertAppHostOrigin(origin, shellOrigin); return true; } catch { return false; }
}

export interface ResolveAppFrameDeps {
  shellOrigin?: string;
  fetch?: typeof fetch;
}

/**
 * What `target` loads. This spends a fresh one-time code, so call it once per
 * navigation and never cache the result.
 */
export async function resolveAppFrame(target: AppFrameTarget, deps: ResolveAppFrameDeps = {}): Promise<ResolvedAppFrame> {
  const shellOrigin = deps.shellOrigin ?? window.location.origin;
  if (!appHostsAvailable(new URL(shellOrigin).host)) throw new AppFrameBlockedError();

  const logical = logicalFrameUrl(target);
  let returnPath = logical.slice(`/api/proxy/${target.instanceId}`.length);
  // "This browser launched the window" (lib/launchOrigin.ts), read once by the page.
  if (takeLaunchMark(target.activityId ?? target.instanceId)) {
    returnPath += `${returnPath.includes('?') ? '&' : '?'}${LAUNCHED_HERE_PARAM}=1`;
  }
  const res = await (deps.fetch ?? fetch)(HANDOFF_ROUTE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: target.appId,
      instanceId: target.instanceId,
      activityId: target.activityId ?? null,
      returnPath,
    }),
  });
  if (!res.ok) throw new Error(`handoff failed (${res.status})`);
  const h = await res.json() as { code?: unknown; origin?: unknown; slot?: unknown; system?: unknown };
  if (typeof h.code !== 'string' || !h.code) throw new Error('handoff returned no code');
  const { origin, label } = assertAppHostOrigin(h.origin, shellOrigin);
  const url = new URL(AURA_RESERVED_PATHS.handoff, origin);
  url.searchParams.set('code', h.code);
  url.searchParams.set('next', returnPath);
  return {
    origin,
    url: url.href,
    label,
    slot: typeof h.slot === 'number' ? h.slot : 1,
    sandbox: APP_FRAME_SANDBOX,
    allow: APP_FRAME_ALLOW,
    system: h.system === true,
  };
}

// ── the iframe ───────────────────────────────────────────────────────────────

const loadSeq = new WeakMap<HTMLIFrameElement, number>();
const readyHooked = new WeakSet<HTMLIFrameElement>();

/** Whether a frame shows (or is opening) an app: `setAppFrameUrl` pointed it at an App Host. */
export function isHostFrame(frame: HTMLIFrameElement): boolean {
  return frame.dataset['auraHostFrame'] === '1';
}

/**
 * Whether a host frame shows the app's `system` installation (D45), as the
 * handoff said. A same-id copy from `global` or `user` is not marked.
 */
export function isSystemHostFrame(frame: HTMLIFrameElement): boolean {
  return isHostFrame(frame) && frame.dataset['auraSystemApp'] === '1';
}

/** The app in a frame. Set by the shell, never read from the app's document. */
export function frameAppId(frame: HTMLIFrameElement): string | null {
  return frame.dataset['auraAppId'] ?? null;
}

/** The origin a frame must be on, for both sending and receiving. */
export function frameExpectedOrigin(frame: HTMLIFrameElement): string | null {
  return isHostFrame(frame) ? (frame.dataset['auraFrameOrigin'] ?? null) : null;
}

/** Whether a frame's document has loaded. Host frames rely on the `load` event alone. */
export function isHostFrameReady(frame: HTMLIFrameElement): boolean {
  return frame.dataset['auraFrameReady'] === '1';
}

/** Post to an app frame at its exact origin. False when it can't receive yet. */
export function postToFrame(frame: HTMLIFrameElement, message: unknown): boolean {
  const w = frame.contentWindow;
  if (!w) return false;
  if (!isHostFrameReady(frame)) return false;
  const origin = frameExpectedOrigin(frame);
  if (!origin) return false;
  try { w.postMessage(message, origin); return true; }
  catch { return false; /* torn-down frame */ }
}

function clearFrameNotice(frame: HTMLIFrameElement): void {
  frame.parentElement?.querySelector(':scope > [data-aura-frame-notice]')?.remove();
}

function showFrameNotice(frame: HTMLIFrameElement, text: string): void {
  const parent = frame.parentElement;
  if (!parent) return;
  clearFrameNotice(frame);
  const el = document.createElement('div');
  el.setAttribute('data-aura-frame-notice', '1');
  el.style.cssText = 'position:absolute;inset:0;z-index:6;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;background:var(--aura-color-bg);color:var(--aura-color-text-dim);font-family:var(--aura-font-mono);font-size:0.75rem;';
  el.textContent = text;
  parent.appendChild(el);
}

function clearHostState(frame: HTMLIFrameElement): void {
  if (!isHostFrame(frame)) return;
  loadSeq.set(frame, (loadSeq.get(frame) ?? 0) + 1);
  frame.removeAttribute('sandbox');
  frame.removeAttribute('allow');
  for (const key of ['auraHostFrame', 'auraFrameOrigin', 'auraFrameReady', 'auraFrameUrl', 'auraAppId', 'auraSystemApp']) delete frame.dataset[key];
  clearFrameNotice(frame);
}

function navigateHostFrame(frame: HTMLIFrameElement, url: string, appId: string): void {
  const target = parseLogicalFrameUrl(url, appId);
  if (!target) { showFrameNotice(frame, 'This window has no valid app address.'); return; }
  const seq = (loadSeq.get(frame) ?? 0) + 1;
  loadSeq.set(frame, seq);
  frame.dataset['auraHostFrame'] = '1';
  frame.dataset['auraAppId'] = appId;
  frame.dataset['auraFrameUrl'] = url;
  delete frame.dataset['auraFrameReady'];
  delete frame.dataset['auraSystemApp'];
  // The sandbox must be in place before the frame ever gets a src.
  frame.setAttribute('sandbox', APP_FRAME_SANDBOX);
  frame.setAttribute('allow', APP_FRAME_ALLOW);
  clearFrameNotice(frame);
  if (!readyHooked.has(frame)) {
    readyHooked.add(frame);
    // Capture, so `ready` is set before the desktop's own load handler posts.
    frame.addEventListener('load', () => {
      if (isHostFrame(frame) && frame.getAttribute('src')) frame.dataset['auraFrameReady'] = '1';
    }, { capture: true });
  }
  resolveAppFrame(target).then((resolved) => {
    if (loadSeq.get(frame) !== seq) return; // a newer navigation won
    frame.dataset['auraFrameOrigin'] = resolved.origin;
    if (resolved.system) frame.dataset['auraSystemApp'] = '1';
    frame.src = resolved.url;
  }).catch((err: unknown) => {
    if (loadSeq.get(frame) !== seq) return;
    if (err instanceof AppFrameBlockedError) {
      // Limited IP mode: the window stays in its workspace and opens after the switch.
      showFrameNotice(frame, 'This app opens from the App Hosts address. Use the link at the top of the screen.');
    } else {
      console.warn('[appFrame] could not open app', appId, (err as Error).message);
      showFrameNotice(frame, 'Could not open this app. Use the reload button to try again.');
    }
  });
}

/** Point a frame at a view's logical URL: its App Host, through a fresh handoff. */
export function setAppFrameUrl(frame: HTMLIFrameElement, url: string, appId: string): void {
  if (isHostFrame(frame) && frame.dataset['auraFrameUrl'] === url && frame.getAttribute('src')) return;
  navigateHostFrame(frame, url, appId);
}

/** Reload a host frame. Its old code is spent, so this takes a new handoff. */
export function reloadHostFrame(frame: HTMLIFrameElement): boolean {
  const url = frame.dataset['auraFrameUrl'];
  const appId = frame.dataset['auraAppId'];
  if (!isHostFrame(frame) || !url || !appId) return false;
  navigateHostFrame(frame, url, appId);
  return true;
}

/** Empty a reusable frame (focus mode), so one app's sandbox can't reach the next. */
export function clearAppFrame(frame: HTMLIFrameElement): void {
  clearHostState(frame);
  frame.src = 'about:blank';
}
