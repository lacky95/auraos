/**
 * The shell's one AuraChannel listener. Every message is checked here, once,
 * before any handler sees it:
 *
 *   1. the type is in the AuraChannel registry;
 *   2. `event.source` is the shell or a window inside a frame the shell made;
 *   3. `event.origin` is the exact origin that window must have;
 *   4. the route (sender class to shell) is allowed, plus the extra rules in
 *      `authorizeShellMessage`.
 *
 * The inline scripts in OSLayout and LockScreenOverlay run before this module
 * and can't import it, so they register through `window.__auraChannelBoot`
 * (OSLayout's head). Messages for those handlers are held until the checks
 * are installed, then replayed through them.
 */
import {
  isAuraChannelRouteAllowed,
  isAuraChannelType,
  type AuraChannelEndpoint,
  type AuraChannelType,
} from '@aura/core/aura-channel';
import {
  APP_FRAME_SELECTOR,
  frameAppId,
  frameExpectedOrigin,
  isAppHostOriginOf,
  isHostFrame,
  type FrameRoute,
} from './appFrame.ts';

const SETTINGS_APP_ID = 'com.aura.settings';
const CONSOLE_APP_ID = 'com.aura.console';
const MAX_FRAME_DEPTH = 20;

/** A frame the shell made, as the checks see it. */
export interface ChannelFrame<W = unknown, E = HTMLIFrameElement> {
  window: W;
  origin: string | null;
  appId: string | null;
  route: FrameRoute;
  element: E;
}

export interface ChannelSender<E = HTMLIFrameElement> {
  endpoint: AuraChannelEndpoint;
  /** The shell frame the sender is in. Null for the shell's own document. */
  frame: ChannelFrame<unknown, E> | null;
  /** The sender IS that frame's document, not something nested inside it. */
  direct: boolean;
}

export interface ClassifyInput<E = HTMLIFrameElement> {
  source: unknown;
  origin: string;
  shellWindow: unknown;
  shellOrigin: string;
  frames: Iterable<ChannelFrame<unknown, E>>;
}

function parentOf(w: unknown): unknown {
  try { return (w as { parent?: unknown }).parent ?? null; }
  catch { return null; }
}

/** Who sent this, from `source` and `origin` only. Null means drop it. */
export function classifySender<E>(input: ClassifyInput<E>): ChannelSender<E> | null {
  const { source, origin, shellWindow, shellOrigin } = input;
  if (!source) return null;
  if (source === shellWindow) {
    return origin === shellOrigin ? { endpoint: 'shell', frame: null, direct: true } : null;
  }
  const frames = [...input.frames];
  let cur: unknown = source;
  for (let hops = 0; cur && cur !== shellWindow && hops < MAX_FRAME_DEPTH; hops++) {
    const frame = frames.find((f) => f.window === cur);
    if (frame) {
      if (!frame.origin) return null;
      if (hops === 0) {
        return origin === frame.origin ? { endpoint: 'app', frame, direct: true } : null;
      }
      if (origin === frame.origin) return { endpoint: 'app', frame, direct: false };
      if (frame.route === 'host' && isAppHostOriginOf(origin, shellOrigin)) {
        return { endpoint: 'embedded-app', frame, direct: false };
      }
      return { endpoint: 'app-subframe', frame, direct: false };
    }
    const next = parentOf(cur);
    if (next === cur) return null;
    cur = next;
  }
  return null;
}

/** Whether a verified sender may deliver this message to the shell. */
export function authorizeShellMessage<E>(
  type: unknown,
  sender: ChannelSender<E>,
  data: { source?: unknown },
  ctx: { nativeRuntime: boolean },
): boolean {
  if (!isAuraChannelType(type)) return false;
  const frame = sender.frame;

  // `source: 'host'` is forgeable by any frame, so it proves nothing. The
  // handlers bind each hint to the sender's own window.
  if (isAuraChannelRouteAllowed(type, 'native-host', 'shell')) {
    if (data.source !== 'host' || !frame) return false;
    // PHASE2-CUTOVER: proxy frames keep the unverified native path; only the host rule remains.
    if (frame.route === 'proxy') return true;
    return ctx.nativeRuntime;
  }

  // Locking the desktop and collecting the admin credential belong to Settings.
  if (type === 'aura.lockscreen.activate' || type === 'aura.admin.unlock.request') {
    return !!frame && sender.direct && frame.appId === SETTINGS_APP_ID
      && isAuraChannelRouteAllowed(type, sender.endpoint, 'shell');
  }

  // The shell's console holds other apps' output.
  if (type === 'aura.console.requestBacklog' && frame?.route === 'host' && frame.appId !== CONSOLE_APP_ID) {
    return false;
  }

  // PHASE2-CUTOVER: a third-party frame inside a proxy app still reports taps for window focus.
  if (type === 'aura.pointerdown' && sender.endpoint === 'app-subframe' && frame?.route === 'proxy') return true;

  return isAuraChannelRouteAllowed(type, sender.endpoint, 'shell');
}

/**
 * The app id a message speaks for. A host frame's id comes from the frame.
 * PHASE2-CUTOVER: drop the claimed id once no proxy frame remains.
 */
export function senderAppId<E>(sender: ChannelSender<E>, claimed: unknown): string | null {
  if (sender.frame?.route === 'host') return sender.frame.appId;
  return typeof claimed === 'string' ? claimed : null;
}

/**
 * A document nested inside a host frame that runs Aura's runtime: the app's
 * own subframe or another App Host. A third-party frame never qualifies, so it
 * can't claim keyboard focus and receive what the user types.
 */
export function isHostNestedSender<E>(sender: ChannelSender<E>): boolean {
  return !sender.direct && sender.frame?.route === 'host'
    && (sender.endpoint === 'app' || sender.endpoint === 'embedded-app');
}

/**
 * How a message moves keyboard focus inside a host frame. The runtime reports
 * a focused nested frame with `aura.keyboard.hello {focused: true}`. Focus
 * returning to the window's own document ends it, or keys would stay nested.
 */
export function nestedFocusChange<E>(
  type: string,
  sender: ChannelSender<E>,
  data: Record<string, unknown>,
): 'set' | 'clear' | 'clear-own' | null {
  if (sender.frame?.route !== 'host') return null;
  if (sender.direct) {
    return type === 'aura.pointerdown' || (type === 'aura.keyboard.field' && data['focused'] === true) ? 'clear' : null;
  }
  if (!isHostNestedSender(sender)) return null;
  if ((type === 'aura.keyboard.hello' || type === 'aura.keyboard.field') && data['focused'] === true) return 'set';
  return type === 'aura.keyboard.field' ? 'clear-own' : null;
}

// ── the listener ─────────────────────────────────────────────────────────────

export interface AuraChannelEvent {
  type: AuraChannelType;
  data: Record<string, unknown>;
  source: MessageEventSource | null;
  origin: string;
  sender: ChannelSender;
}

export type AuraChannelHandler = (ev: AuraChannelEvent) => void;

interface ChannelBoot {
  handlers: Record<string, AuraChannelHandler[]>;
  early: MessageEvent[];
  listener: (ev: MessageEvent) => void;
  on: (type: string, fn: AuraChannelHandler) => void;
}

type ChannelWindow = Window & { __auraChannelBoot?: ChannelBoot };

let handlers: Record<string, AuraChannelHandler[]> | null = null;
let nativeRuntime: () => boolean = () => false;

/** The native bridge check, supplied by the desktop (lib/nativeSurface.ts). */
export function setNativeRuntimeCheck(check: () => boolean): void {
  nativeRuntime = check;
}

function knownFrames(): ChannelFrame[] {
  return [...document.querySelectorAll<HTMLIFrameElement>(APP_FRAME_SELECTOR)].map((element) => ({
    window: element.contentWindow,
    origin: frameExpectedOrigin(element),
    appId: frameAppId(element),
    route: isHostFrame(element) ? 'host' as const : 'proxy' as const,
    element,
  }));
}

// A nested App Host frame the user is typing in, per shell frame. The Shell
// posts keys straight to it, so the embedding app is never a relay (D29).
const nestedFocus = new WeakMap<HTMLIFrameElement, { source: Window; origin: string }>();

function noteNestedFocus(ev: AuraChannelEvent): void {
  const frame = ev.sender.frame;
  if (!frame) return;
  const change = nestedFocusChange(ev.type, ev.sender, ev.data);
  if (change === 'set') nestedFocus.set(frame.element, { source: ev.source as Window, origin: ev.origin });
  else if (change === 'clear-own' && nestedFocus.get(frame.element)?.source === ev.source) nestedFocus.delete(frame.element);
  else if (change === 'clear') nestedFocus.delete(frame.element);
}

/** The nested frame holding keyboard focus inside `frame`, if it is still there. */
export function focusedNestedFrame(frame: HTMLIFrameElement): { source: Window; origin: string } | null {
  const nested = nestedFocus.get(frame);
  if (!nested) return null;
  if (nested.source.closed) { nestedFocus.delete(frame); return null; }
  return nested;
}

function dispatch(ev: MessageEvent): void {
  const data = ev.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object' || !handlers) return;
  const type = data['type'];
  if (!isAuraChannelType(type)) return;
  const sender = classifySender({
    source: ev.source,
    origin: ev.origin,
    shellWindow: window,
    shellOrigin: window.location.origin,
    frames: knownFrames(),
  });
  if (!sender || !authorizeShellMessage(type, sender, data, { nativeRuntime: nativeRuntime() })) return;
  const msg: AuraChannelEvent = { type, data, source: ev.source, origin: ev.origin, sender };
  noteNestedFocus(msg);
  for (const fn of [...(handlers[type] ?? []), ...(handlers['*'] ?? [])]) {
    try { fn(msg); } catch (err) { console.error('[aura-channel] handler failed', type, err); }
  }
}

/** Install the listener once, taking over from the inline bootstrap. */
export function installShellChannel(): void {
  if (handlers) return;
  const boot = (window as ChannelWindow).__auraChannelBoot;
  handlers = boot?.handlers ?? Object.create(null) as Record<string, AuraChannelHandler[]>;
  window.addEventListener('message', dispatch);
  if (boot) {
    window.removeEventListener('message', boot.listener);
    for (const ev of boot.early.splice(0)) dispatch(ev);
  }
}

/** Handle verified messages of these types (`'*'` = every type). Returns the unsubscribe. */
export function onAuraChannel(types: AuraChannelType | '*' | Array<AuraChannelType>, fn: AuraChannelHandler): () => void {
  installShellChannel();
  const list = Array.isArray(types) ? types : [types];
  for (const t of list) (handlers![t] ??= []).push(fn);
  return () => {
    for (const t of list) {
      const arr = handlers?.[t];
      const i = arr ? arr.indexOf(fn) : -1;
      if (i >= 0) arr!.splice(i, 1);
    }
  };
}

/** Answer a verified message, at the sender's exact origin. */
export function replyTo(ev: Pick<AuraChannelEvent, 'source' | 'origin'>, message: unknown): void {
  if (!ev.source || !ev.origin || ev.origin === 'null') return;
  try { (ev.source as Window).postMessage(message, ev.origin); }
  catch { /* frame gone */ }
}
