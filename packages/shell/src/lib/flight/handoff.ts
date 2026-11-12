/**
 * Hand an activity's live iframe between a desktop window slot and the flight
 * layer, so take-off (window → flight) and land (flight → window) don't reload
 * the app (a reload would drop e.g. a running call).
 *
 * Moving an iframe with appendChild/insertBefore detaches it first, which
 * unloads its document. `Element.moveBefore` (Chromium 133+) moves a
 * connected node atomically and keeps its state. The giver PARKS the iframe in
 * a connected staging element right away (the old slot / panel is removed in
 * the same task); the receiver CLAIMS it when it builds its new container.
 * Without `moveBefore` the same calls still work, the app just reloads.
 */

const parked = new Map<string, HTMLIFrameElement>();

type Movable = Element & { moveBefore?: (node: Node, child: Node | null) => void };

export function canMoveLive(): boolean {
  return typeof (Element.prototype as Movable).moveBefore === 'function';
}

/** Move `node` under `parent` (before `before`), keeping it alive when possible. */
export function moveInto(parent: Element, node: Element, before: Node | null = null): boolean {
  const p = parent as Movable;
  if (typeof p.moveBefore === 'function' && node.isConnected && parent.isConnected) {
    try { p.moveBefore(node, before); return true; } catch { /* fall through */ }
  }
  parent.insertBefore(node, before);
  return false;
}

function staging(): HTMLElement {
  let el = document.getElementById('flight-staging');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flight-staging';
    el.setAttribute('aria-hidden', 'true');
    // Connected and laid out (a display:none parent can throttle the app), but unseen.
    el.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:200px;overflow:hidden;pointer-events:none;';
    document.body.appendChild(el);
  }
  return el;
}

/** The giver: keep `iframe` alive for the activity's next container. */
export function parkFrame(activityId: string, iframe: HTMLIFrameElement): void {
  if (!iframe.isConnected) return;
  moveInto(staging(), iframe);
  parked.set(activityId, iframe);
  // Not claimed soon (the receiver failed): don't leak a running app.
  setTimeout(() => {
    if (parked.get(activityId) === iframe) { parked.delete(activityId); iframe.remove(); }
  }, 15_000);
}

/** Is an iframe waiting for this activity? (Peek — does not take it.) */
export function hasParkedFrame(activityId: string): boolean {
  return !!parked.get(activityId)?.isConnected;
}

/** The receiver: the parked iframe for this activity, if any (taken once). */
export function claimFrame(activityId: string): HTMLIFrameElement | null {
  const f = parked.get(activityId) ?? null;
  parked.delete(activityId);
  return f && f.isConnected ? f : null;
}
