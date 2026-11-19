import type { APIRoute } from 'astro';
import { FRAME_RELAY_JS } from '../../../lib/keyboard/frameRelayScript.js';
import { SYNTHETIC_RECEIVER_JS } from '../../../lib/keyboard/receiverScript.js';
import { NATIVE_KEYBOARD_JS } from '../../../lib/keyboard/nativeKeyboardScript.js';
import { withEtag } from '../../../lib/etag.js';

/**
 * The virtual keyboard for documents the shell proxy doesn't inject into —
 * app hosts (`{name}--{host}`, docs: App hosts) and the frames inside them:
 *
 *   <script src="https://<desktop host>/api/os/keyboard.js"></script>
 *
 * Relay into child iframes (lib/keyboard/frameRelayScript.ts) first, then the
 * same receiver and device-keyboard policy the proxy injects into every
 * proxied app document. All of it only listens to `window.parent`, so a page
 * loading it can be typed into by its parent frame, never by anyone else.
 * Protocol: components/shell/keyboard/PROTOCOL.md.
 */
const BUNDLE = `${FRAME_RELAY_JS}\n${SYNTHETIC_RECEIVER_JS}\n${NATIVE_KEYBOARD_JS}\n`;

export const GET: APIRoute = ({ request }) => {
  const res = withEtag(request, BUNDLE, 'text/javascript; charset=utf-8');
  // Loaded cross-origin by app hosts; harmless to share.
  res.headers.set('access-control-allow-origin', '*');
  return res;
};
