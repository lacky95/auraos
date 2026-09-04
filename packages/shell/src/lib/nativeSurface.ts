/**
 * Native surfaces — the OS side of `osClient.surface`.
 *
 * A native surface is a real native WebView the host paints *over* one app
 * window, positioned so it looks like part of that window. It exists because
 * some sites cannot run inside a cross-origin iframe at all: duck.ai's
 * anti-abuse challenge reads `window.top.location` while computing the token
 * that gates its UI, and classic frame-busters fail the same way. `window.top`
 * is `[LegacyUnforgeable]`, so there is nothing to shim — the page genuinely
 * has to be a top-level document, and only the host can provide one.
 *
 * Division of responsibility, deliberately:
 *   - The OS (this module) owns the *capability*: coordinate translation,
 *     keeping the surface glued to its window through every reflow, and
 *     tearing it down when the window goes away. Apps cannot do any of that —
 *     they can't see their own position on screen, let alone in device pixels.
 *   - The app owns the *policy*: whether to use a surface at all, for which
 *     URL, and which part of its own layout the surface should cover. The
 *     browser app knows it just failed to frame something; the OS does not.
 *
 * Coordinates cross three spaces. Apps speak their own CSS pixels. The shell
 * speaks top-level CSS pixels. The host speaks device pixels. This module owns
 * the first hop and hands the host a `dpr` for the second.
 *
 * Surfaces are per-window, not per-device: each app window that asks for one
 * gets its own native view, keyed by the surfaceId it chose. Opening a second
 * Browser window therefore brings up a second native view rather than stealing
 * the first one's.
 */

/** A rectangle in the requesting app's own CSS pixel space. */
export interface SurfaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ActiveSurface {
  surfaceId: string;
  frame: HTMLIFrameElement;
  url: string;
  /** App-local CSS px, as last requested by the app. */
  rect: SurfaceRect;
  /** Last rect pushed to native, to suppress redundant bridge calls. */
  lastPushed: string;
  /** Which overlay is currently covering it, or null. Diffed to notify once. */
  occludedBy: string | null;
  /** True once the owning app has acted on the notification and hidden it. */
  hiddenByApp: boolean;
}

/**
 * Shell overlays that can cover a native surface.
 *
 * A surface is a native view painted over the whole activity, so nothing in
 * the shell's DOM can draw on top of it — an overlay opening over the Browser
 * window would simply be invisible. The OS reports the overlap and the owning
 * app hides the surface for as long as it lasts.
 *
 * The dialog entry is a catch-all: About and Viewport are both Radix portals
 * into <body>, so any future dialog built on @aura/ui's Dialog is covered
 * without touching this list.
 */
const OVERLAY_SELECTORS: ReadonlyArray<{ name: string; selector: string }> = [
  { name: 'launcher',       selector: '#lo-panel[aria-hidden="false"]' },
  { name: 'processManager', selector: '#pm-panel[aria-hidden="false"]' },
  { name: 'lockscreen',     selector: '#lockscreen[aria-hidden="false"]' },
  { name: 'dialog',         selector: '[role="dialog"][data-state="open"]' },
  { name: 'workspaces',     selector: '#ws-bundle[data-open="true"] #ws-content' },
  { name: 'workspaceMenu',  selector: '#ws-ctx:not([hidden])' },
];

/** True when the element is actually painted — not display:none/visibility:hidden. */
function isPainted(el: Element): boolean {
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
}

function intersects(a: SurfaceRect, b: DOMRect): boolean {
  return a.x < b.right && b.left < a.x + a.width
      && a.y < b.bottom && b.top < a.y + a.height;
}

/**
 * Which overlay, if any, currently covers `rect` (top-level CSS px).
 *
 * Intersection rather than "any overlay is open": the launcher and process
 * manager are side panels, and one opening on the far side of the screen has
 * no business blanking the page. Modal dialogs carry a full-screen dimming
 * backdrop, so they intersect by construction and always win.
 */
function occluderOf(rect: SurfaceRect): string | null {
  for (const { name, selector } of OVERLAY_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      if (!isPainted(el)) continue;
      // A closed panel is translated off-screen, so its rect stops
      // intersecting on its own as the slide-out transition runs.
      if (intersects(rect, el.getBoundingClientRect())) return name;
    }
  }
  return null;
}

/**
 * Every live surface, keyed by its id. One per app window: a second Browser
 * window gets its own native view rather than stealing the first one's, which
 * is why the host keys its surfaces the same way.
 */
const surfaces = new Map<string, ActiveSurface>();
let rafId = 0;

/**
 * Geometry tracker. A ResizeObserver is not enough: it fires on size changes
 * only, so a tiling reflow that *moves* a window without resizing it would
 * leave the surface behind. Nothing in the DOM reports "my position changed",
 * so the rect is polled instead — one getBoundingClientRect per frame, and
 * only while a surface is actually attached, which is rare and short-lived.
 * The push itself is deduped, so a still window costs a compare and nothing
 * crosses the bridge.
 */
function startTracking(): void {
  if (rafId) return;
  const tick = (): void => {
    if (surfaces.size === 0) { rafId = 0; return; }
    for (const surface of [...surfaces.values()]) {
      // A frame detached from the document means its window is gone.
      if (!surface.frame.isConnected) { detach(surface.frame, surface.surfaceId); continue; }
      checkOcclusion(surface);
      push(surface);
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function stopTracking(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

/** Commands a host app can drive its surface with. */
export type SurfaceCommand =
  | 'navigate' | 'goBack' | 'goForward' | 'reload' | 'setZoom' | 'getState' | 'setVisible';

type NativeMethod = 'open' | 'close' | 'setBounds' | SurfaceCommand;

type CapacitorBridge = {
  Plugins?: { AuraBrowser?: Record<string, ((o?: unknown) => Promise<unknown>) | undefined> };
  nativePromise?: (plugin: string, method: string, options: unknown) => Promise<unknown>;
  addListener?: (plugin: string, event: string, cb: (data: unknown) => void) => unknown;
};

function bridge(): CapacitorBridge | null {
  const cap = (window as { Capacitor?: CapacitorBridge }).Capacitor;
  if (!cap) return null;
  // Capacitor.Plugins only exists when @capacitor/core is bundled; the host
  // injects the bare native-bridge.js, which offers nativePromise instead.
  return (cap.Plugins?.AuraBrowser || cap.nativePromise) ? cap : null;
}

/** True when the host can actually paint a native surface. */
export function isSupported(): boolean {
  return bridge() !== null;
}

async function callNative(method: NativeMethod, options: unknown): Promise<unknown> {
  const cap = bridge();
  if (!cap) return undefined;
  try {
    const direct = cap.Plugins?.AuraBrowser?.[method];
    if (direct) return await direct(options);
    return await cap.nativePromise!('AuraBrowser', method, options ?? {});
  } catch (err) {
    console.warn('[surface] native', method, 'failed', err);
    return undefined;
  }
}

/**
 * Drive the attached surface. Only the frame that owns it may command it —
 * a surface is as much a part of an app's window as its own DOM.
 */
export function command(
  frame: HTMLIFrameElement,
  surfaceId: string,
  action: SurfaceCommand,
  payload: Record<string, unknown> = {},
): void {
  const surface = surfaces.get(surfaceId);
  if (!surface || surface.frame !== frame) return;
  if (action === 'setVisible') {
    const visible = payload['visible'] !== false;
    surface.hiddenByApp = !visible;
    void callNative('setVisible', { surfaceId, visible });
    // Re-place it before it is painted again: the window may have moved while
    // it was hidden, and bounds pushes were suppressed for the duration.
    if (visible) push(surface, true);
    return;
  }
  void callNative(action, { surfaceId, ...payload });
}

/**
 * Relay native navigation state to whichever app owns the surface. The app's
 * address bar, title and back/forward buttons run on these — from inside an
 * iframe there is no other way to observe a native view.
 */
function startStateRelay(): void {
  if (stateRelayInstalled) return;
  const cap = bridge();
  if (!cap?.addListener) return;
  stateRelayInstalled = true;
  try {
    cap.addListener('AuraBrowser', 'browserState', (data: unknown) => {
      // The host stamps every event with its surfaceId, which is the only way
      // to know which window's address bar this belongs to now that several
      // can be open at once.
      const id = (data as { surfaceId?: unknown } | null)?.surfaceId;
      const surface = typeof id === 'string' ? surfaces.get(id) : undefined;
      if (!surface) return;
      try {
        surface.frame.contentWindow?.postMessage(
          { type: 'aura.surface.state', surfaceId: surface.surfaceId, state: data }, '*');
      } catch { /* frame gone */ }
    });
  } catch (err) {
    console.warn('[surface] state relay unavailable', err);
    stateRelayInstalled = false;
  }
}

let stateRelayInstalled = false;

/**
 * Translate an app-local rect into top-level CSS pixels.
 *
 * The iframe carries `transform: scale(iframeScale)` with a compensating
 * `width: calc(100%/iframeScale)`, and the shell may scale an ancestor on top
 * of that. Rather than reading either factor from CSS vars — two places to
 * drift — the scale is measured: getBoundingClientRect() is the painted box
 * (all ancestor transforms applied) while clientWidth is the layout box the
 * app renders into, so their ratio is the true app-px to top-level-px factor.
 *
 * @returns null when the frame is not currently painted (a slot on an
 *          inactive workspace measures 0×0).
 */
function toTopLevel(frame: HTMLIFrameElement, rect: SurfaceRect): SurfaceRect | null {
  const box = frame.getBoundingClientRect();
  const layoutW = frame.clientWidth;
  const layoutH = frame.clientHeight;
  if (!layoutW || !layoutH || !box.width || !box.height) return null;

  const scaleX = box.width / layoutW;
  const scaleY = box.height / layoutH;
  return {
    x:      box.left + rect.x * scaleX,
    y:      box.top  + rect.y * scaleY,
    width:  rect.width  * scaleX,
    height: rect.height * scaleY,
  };
}

/**
 * Tell the owning app when an overlay starts or stops covering its surface.
 * Measured on the same rAF tick as the geometry, so it tracks a panel through
 * its slide-in transition rather than waiting for a transition-end event.
 */
function checkOcclusion(surface: ActiveSurface): void {
  const top = toTopLevel(surface.frame, surface.rect);
  // Unmeasurable (the slot is on another workspace, so it has no box). Keep the
  // last verdict rather than reporting "clear": push() has already collapsed
  // the surface to nothing, and claiming it is visible would un-hide it the
  // moment the slot comes back under an overlay that is still open.
  if (!top) return;
  const by = occluderOf(top);
  if (by === surface.occludedBy) return;
  surface.occludedBy = by;
  try {
    surface.frame.contentWindow?.postMessage({
      type: 'aura.surface.occluded',
      surfaceId: surface.surfaceId,
      occluded: by !== null,
      by,
    }, '*');
  } catch { /* frame gone */ }
}

/** Push the current geometry to the host, deduped. */
function push(surface: ActiveSurface, force = false): void {
  // A hidden surface is not painted, so re-placing it is pure bridge traffic.
  // The un-hide path forces a push so a window moved while hidden reappears
  // in the right place.
  if (surface.hiddenByApp && !force) return;
  const top = toTopLevel(surface.frame, surface.rect);
  // Not painted right now — the slot is display:none on another workspace, or
  // minimised. Send nothing: a zero-size rect is not a position, and the host
  // reads an unusable rect as "no bounds given", which means fullscreen. The
  // owning app hides the surface instead (it sees its own box collapse).
  if (!top) return;
  const bounds = { ...top, dpr: window.devicePixelRatio || 1 };

  const key = `${bounds.x}|${bounds.y}|${bounds.width}|${bounds.height}|${bounds.dpr}`;
  if (!force && key === surface.lastPushed) return;
  surface.lastPushed = key;
  void callNative('setBounds', { surfaceId: surface.surfaceId, bounds });
}

/** Attach (or replace) the native surface for one app frame. */
export function attach(
  frame: HTMLIFrameElement,
  surfaceId: string,
  url: string,
  rect: SurfaceRect,
  opts: { chrome?: boolean } = {},
): boolean {
  if (!isSupported()) return false;
  const top = toTopLevel(frame, rect);
  if (!top) {
    console.warn('[surface] refusing to attach to an unpainted frame');
    return false;
  }
  // Re-attaching from the same window replaces that window's surface rather
  // than stacking a second native view behind the first.
  for (const existing of [...surfaces.values()]) {
    if (existing.frame === frame && existing.surfaceId !== surfaceId) {
      surfaces.delete(existing.surfaceId);
      void callNative('close', { surfaceId: existing.surfaceId });
    }
  }
  const bounds = { ...top, dpr: window.devicePixelRatio || 1 };
  const surface: ActiveSurface = {
    surfaceId, frame, url, rect,
    lastPushed: `${bounds.x}|${bounds.y}|${bounds.width}|${bounds.height}|${bounds.dpr}`,
    occludedBy: null, hiddenByApp: false,
  };
  surfaces.set(surfaceId, surface);
  // chrome:false → the host renders only the page. A host app driving the
  // surface with its own address bar must not get a second one stacked on top.
  void callNative('open', { surfaceId, url, bounds, chrome: opts.chrome !== false });
  startStateRelay();
  installUnloadTeardown();
  startTracking();
  return true;
}

/** Update the surface rect within the app's own layout. */
export function setRect(frame: HTMLIFrameElement, surfaceId: string, rect: SurfaceRect): void {
  const surface = surfaces.get(surfaceId);
  if (!surface || surface.frame !== frame) return;
  surface.rect = rect;
  push(surface);
}

/**
 * Close the surface when the shell document itself goes away — reload, in-place
 * navigation, or the host tearing the WebView down.
 *
 * The native view is attached to the activity, not to this document, so it
 * survives a reload on its own: without this it keeps rendering over a fresh
 * shell with nobody owning it. It only looked harmless before because the
 * Browser app usually restarts and re-attaches over the top — an app that does
 * not come back leaves its window stranded.
 *
 * `pagehide` rather than `unload`: it fires for bfcache and is not deprecated.
 * The bridge call is a synchronous post to native, so it makes it out.
 */
function installUnloadTeardown(): void {
  if (unloadInstalled || typeof window === 'undefined') return;
  unloadInstalled = true;
  window.addEventListener('pagehide', () => {
    const ids = [...surfaces.keys()];
    surfaces.clear();
    stopTracking();
    for (const surfaceId of ids) void callNative('close', { surfaceId });
  });
}

let unloadInstalled = false;

/**
 * Close one surface, or every surface owned by `frame` when no id is given —
 * the latter is the window-teardown path, where the app is already gone and
 * cannot tell us which ids it held.
 */
export function detach(frame: HTMLIFrameElement, surfaceId?: string): void {
  for (const surface of [...surfaces.values()]) {
    if (surface.frame !== frame) continue;
    if (surfaceId && surface.surfaceId !== surfaceId) continue;
    surfaces.delete(surface.surfaceId);
    void callNative('close', { surfaceId: surface.surfaceId });
  }
  if (surfaces.size === 0) stopTracking();
}

/**
 * Re-sync after a layout change. Called from the viewport broadcaster, which
 * already fires for every reflow, zoom, workspace switch and window resize —
 * the surface has to follow all of them or it visibly detaches from its window.
 */
export function syncFor(frame: HTMLIFrameElement): void {
  for (const surface of surfaces.values()) {
    if (surface.frame === frame) push(surface);
  }
}

/** Tear down a surface whose window is closing. */
export function detachIfOwnedBy(frame: HTMLIFrameElement): void {
  detach(frame);
}

/** How many native surfaces are live right now. */
export function count(): number {
  return surfaces.size;
}
