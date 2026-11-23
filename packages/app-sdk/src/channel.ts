/**
 * The SDK's one way to talk to the shell over postMessage (AuraChannel).
 *
 * On an App Host the shell is `window.top` at the exact origin from the runtime
 * bootstrap: reports go only there, and a message counts only if both its
 * origin and its source window match. An embedding parent app or a nested
 * frame can't pose as the shell, and neither can a `native-host` message, whose
 * `source: 'host'` any frame can forge.
 */
import { appHostRuntime } from './os-auth.js';

export function postToShell(message: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  const host = appHostRuntime();
  try {
    if (host) {
      if (window.top && window.top !== window) window.top.postMessage(message, host.shellOrigin);
      return;
    }
    // PHASE2-CUTOVER: proxied documents post to their parent with target `*`.
    if (window.parent !== window) window.parent.postMessage(message, '*');
  } catch { /* shell gone */ }
}

/** Whether a received message really came from the shell. */
export function isFromShell(ev: MessageEvent): boolean {
  const host = appHostRuntime();
  if (host) return ev.origin === host.shellOrigin && ev.source === window.top;
  // PHASE2-CUTOVER: proxied documents keep their per-listener checks until proxy serving goes.
  return true;
}
