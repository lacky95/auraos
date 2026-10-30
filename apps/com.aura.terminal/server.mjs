// Production entry (core appBuild.ts runs it when the build is current): the
// standalone Astro server plus the PTY WebSocket on /ws — what the dev server
// gets from ptyWsIntegration in astro.config.mjs.
process.env.ASTRO_NODE_AUTOSTART = 'disabled';

const { startServer } = await import('./dist/server/entry.mjs');
const { server } = startServer();
const http = server.server;
const KEY = Symbol.for('aura.terminal.getPtyWss');
const port = process.env.PORT ?? process.env.APP_PORT ?? '4001';

// Load + arm the bundled PTY module (src/pages/api/pty-ready.ts registers KEY).
let ready = null;
function ensurePty() {
  if (globalThis[KEY]) return Promise.resolve(globalThis[KEY]);
  ready ??= fetch(`http://127.0.0.1:${port}/api/pty-ready`)
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

http.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname !== '/ws') return;
  ensurePty().then((get) => {
    if (!get) { socket.destroy(); return; }
    const wss = get();
    wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client, req));
  }, () => socket.destroy());
});
