// Production entry (core appBuild.ts runs it when the build is current; manifest
// "serve": "auto"): the standalone Astro server plus the log WebSocket on /ws,
// what the dev server gets from logWsIntegration in astro.config.mjs. Same
// pattern as the Terminal's server.mjs. Also how Console runs from a read-only
// AuraOS release (Normal Mode): built once by the release builder, never astro dev.
process.env.ASTRO_NODE_AUTOSTART = 'disabled';

const { startServer } = await import('./dist/server/entry.mjs');
const { server } = startServer();
const http = server.server;
const KEY = Symbol.for('aura.console.getLogWss');
const port = process.env.PORT ?? process.env.APP_PORT ?? '4001';
const listenHost = !process.env.HOST || process.env.HOST === '0.0.0.0' ? '127.0.0.1' : process.env.HOST;
const selfUrl = `http://${listenHost.includes(':') ? `[${listenHost}]` : listenHost}:${port}`;

// Load the bundled log-server module (src/pages/api/log-ready.ts registers KEY).
let ready = null;
function ensureLogWss() {
  if (globalThis[KEY]) return Promise.resolve(globalThis[KEY]);
  ready ??= fetch(`${selfUrl}/api/log-ready`)
    .then(() => globalThis[KEY])
    .finally(() => { ready = null; });
  return ready;
}
http.once('listening', () => {
  ensureLogWss().then(
    (get) => console.log(get ? '[console] log WebSocket attached on /ws' : '[console] log module did not register'),
    (err) => console.error('[console] log WebSocket warm-up failed:', err?.message ?? err),
  );
});

http.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname !== '/ws') return;
  ensureLogWss().then((get) => {
    if (!get) { socket.destroy(); return; }
    const wss = get();
    wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client, req));
  }, () => socket.destroy());
});
