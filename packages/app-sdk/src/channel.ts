/**
 * The SDK's one way to talk to the shell over postMessage (AuraChannel).
 *
 * The shell is `window.top` at the exact origin from the runtime bootstrap:
 * reports go only there, and a message counts only if both its origin and its
 * source window match. An embedding parent app or a nested frame can't pose as
 * the shell, and neither can a `native-host` message, whose `source: 'host'`
 * any frame can forge. Without the bootstrap (outside AuraOS, or a page that
 * doesn't load `/_aura/runtime.js`) there is no shell to talk to: nothing is
 * sent and nothing is accepted.
 */
import { appHostRuntime } from './os-auth.js';

export function postToShell(message: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  const host = appHostRuntime();
  if (!host || !window.top || window.top === window) return;
  try {
    window.top.postMessage(message, host.shellOrigin);
  } catch { /* shell gone */ }
}

/** Whether a received message really came from the shell. */
export function isFromShell(ev: MessageEvent): boolean {
  const host = appHostRuntime();
  return host !== null && ev.origin === host.shellOrigin && ev.source === window.top;
}
