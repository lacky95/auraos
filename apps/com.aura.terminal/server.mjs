// Production entry (core appBuild.ts runs it when the build is current): the
// standalone Astro server plus the PTY WebSocket on /ws — what the dev server
// gets from ptyWsIntegration in astro.config.mjs.
process.env.ASTRO_NODE_AUTOSTART = 'disabled';
// Stream T: take this start's lifecycle token from its one-time file first (app-sdk lifecycle-secret), before
// anything could start a session; it is never in this server's env (a session host's sessions share its uid).
(await import('@aura/app-sdk/lifecycle-secret')).lifecycleSecret();
const { RELAY_CLAIM_HEADER, checkShellRelay, relayServesSessionUser } = await import('@aura/app-sdk/shell-peer');

/** The PTY upgrade came through the shell (app-sdk shell-peer, D89 B4 relay claim), for this instance's user (D69). */
const shellRelayed = async (req) => relayServesSessionUser(await checkShellRelay({
  peer: req.socket.remoteAddress, header: req.headers[RELAY_CLAIM_HEADER], method: req.method ?? 'GET', path: req.url ?? '/',
}));

const { startServer } = await import('./dist/server/entry.mjs');
const { server } = startServer();
const http = server.server;
const KEY = Symbol.for('aura.terminal.getPtyWss');
const port = process.env.PORT ?? process.env.APP_PORT ?? '4001';
// The address the server listens on (core provisioning.ts LISTEN_HOST_SHELL):
// only the private Terminal network's (D58), so loopback reaches nothing.
const listenHost = !process.env.HOST || process.env.HOST === '0.0.0.0' ? '127.0.0.1' : process.env.HOST;
const selfUrl = `http://${listenHost.includes(':') ? `[${listenHost}]` : listenHost}:${port}`;

// Load + arm the bundled PTY module (src/pages/api/pty-ready.ts registers KEY).
let ready = null;
function ensurePty() {
  if (globalThis[KEY]) return Promise.resolve(globalThis[KEY]);
  ready ??= fetch(`${selfUrl}/api/pty-ready`)
    .then(() => globalThis[KEY])
    .finally(() => { ready = null; });
  return ready;
}
http.once('listening', () => {
  ensurePty().then(
    (get) => console.log(get ? '[terminal] PTY WebSocket attached on /ws' : '[terminal] PTY module did not register'),
    (err) => console.error('[terminal] PTY warm-up failed:', err?.message ?? err),
  );
});

http.on('upgrade', async (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname !== '/ws') return;
  // Only the shell relays a PTY socket (src/middleware.ts, H4 stopgap).
  // D89 B4: and carries its relay claim (warn: reported; strict: required).
  if (!(await shellRelayed(req))) { socket.destroy(); return; }
  ensurePty().then((get) => {
    if (!get) { socket.destroy(); return; }
    const wss = get();
    wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client, req));
  }, () => socket.destroy());
});
