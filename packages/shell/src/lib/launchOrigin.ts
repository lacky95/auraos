/**
 * "Launched here" marks — which browser actually started a window.
 *
 * A launch is server-side state, so a new window shows up in EVERY browser the
 * user has open and each of them mounts its own iframe for it. For an app that
 * can only be live in one browser at a time (the Terminal: one PTY, one
 * winsize — see its pty-server) that turns into a race, and the winner is
 * simply whichever iframe's socket connected first. That is regularly NOT the
 * browser the user launched from — they press the dock icon and get a window
 * saying the terminal is in use somewhere else.
 *
 * So the launching browser leaves a mark and the app claims itself when it
 * finds one. Ordering is safe by construction: we know the id the moment
 * `/start` (or `/activities`) answers, which is strictly BEFORE the iframe for
 * that window exists — so the app can only ever read the mark after it was
 * written. No handshake, no timing window, and nothing to retry.
 *
 * `sessionStorage` is exactly the right transport here. It is scoped to one
 * browser TAB, and app iframes are proxied from the shell's own origin
 * (`/api/proxy/…`), so every iframe in this tab reads what the shell wrote
 * while another tab — or another browser, or another device — sees nothing.
 *
 * The contract for apps (the Terminal implements it):
 *
 *   key    'aura.launchedHere'
 *   value  JSON `{ [viewId]: epochMs }`, viewId === activityId ?? instanceId
 *   use    on start-up, look for your own id; if it's there, DELETE it and
 *          write the map back, then take the session for this browser.
 *
 * Consuming the mark is the app's job and must happen exactly once: it says
 * "this page load was the launch", so a later reload of the same window must
 * not silently steal the session back from wherever the user moved it.
 *
 * An App Host frame is on its own origin and can't read this tab's storage, so
 * there the Shell consumes the mark itself when it resolves the frame
 * (lib/appFrame.ts) and adds `_aura_launched=1` to the page's first URL. The
 * app removes the parameter once read (history.replaceState), which keeps a
 * reload from claiming again.
 * PHASE2-CUTOVER: the sessionStorage contract goes with proxy frames; the parameter stays.
 */

export const LAUNCHED_HERE_KEY = 'aura.launchedHere';
/** On an App Host frame's first URL: this browser launched the window. */
export const LAUNCHED_HERE_PARAM = '_aura_launched';

/** A mark stops meaning anything after this long — a window nobody mounted. */
const MAX_AGE_MS = 5 * 60_000;

/**
 * Record that this browser launched `viewId`. Best-effort: if storage is
 * unavailable (private mode, quota) the app just falls back to first-come
 * ownership, which is what happened before this existed.
 */
export function markLaunchedHere(viewId: string): void {
  if (!viewId) return;
  try {
    const now = Date.now();
    const raw = sessionStorage.getItem(LAUNCHED_HERE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const map: Record<string, number> =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, number>)
        : {};
    // Drop marks whose window never came up, so the map can't grow forever in
    // a long-lived tab.
    for (const [id, at] of Object.entries(map)) {
      if (typeof at !== 'number' || now - at > MAX_AGE_MS) delete map[id];
    }
    map[viewId] = now;
    sessionStorage.setItem(LAUNCHED_HERE_KEY, JSON.stringify(map));
  } catch { /* storage unavailable — first-come ownership, as before */ }
}

/** Consume this browser's mark for `viewId`: true once, when it launched that window. */
export function takeLaunchMark(viewId: string): boolean {
  if (!viewId) return false;
  try {
    const raw = sessionStorage.getItem(LAUNCHED_HERE_KEY);
    const map: unknown = raw ? JSON.parse(raw) : null;
    if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
    const at = (map as Record<string, unknown>)[viewId];
    if (typeof at !== 'number') return false;
    delete (map as Record<string, unknown>)[viewId];
    sessionStorage.setItem(LAUNCHED_HERE_KEY, JSON.stringify(map));
    return Date.now() - at <= MAX_AGE_MS;
  } catch { return false; }
}
