// App hosts router (server/app-hosts.mjs) against real sockets: a fake
// upstream app, a fake desktop handler, and the router in front of both.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { appHostName, createAppHostRouter } from '../server/app-hosts.mjs';

const listen = (s: http.Server | net.Server) =>
  new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

// The app: echoes what it received; answers WebSocket-style upgrades and echoes bytes.
const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
const app = http.createServer((req, res) => {
  seen.push({ url: req.url ?? '', headers: req.headers });
  res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
  if (req.url === '/redirect') { res.writeHead(302, { location: '/s/abc' }); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/plain', 'x-aura-app-id': 'io.acme.notes' });
  res.end(`app:${req.url}`);
});
app.on('upgrade', (req, socket) => {
  seen.push({ url: req.url ?? '', headers: req.headers });
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  socket.on('data', (d) => socket.write(d));
});
const appPort = await listen(app);

// The shell's own /api/apps/<id>/start, recorded.
const starts: string[] = [];
const shellApi = http.createServer((req, res) => { starts.push(`${req.method} ${req.url}`); res.end('{}'); });
const shellPort = await listen(shellApi);

let apps: any[] = [];
const setApps = (instances: any[]) => {
  apps = [{
    manifest: {
      id: 'io.acme.notes', name: 'Notes',
      hosts: [{ name: 'notes' }, { name: 'worker', service: 'worker' }],
      services: [{ name: 'worker', port: 8787 }],
    },
    instances,
  }];
};
setApps([{ instanceId: 'io.acme.notes', port: appPort, state: 'resumed', inPool: false, sandbox: 'proot' }]);

const router = createAppHostRouter({ appsList: async () => apps, shellPort: String(shellPort) });
const desktop = http.createServer((_req, res) => res.end('desktop'));
desktop.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 418 Desktop\r\n\r\n'));
router.attach(desktop);
const port = await listen(desktop);
await new Promise((r) => setTimeout(r, 50));   // the index warms on attach

after(() => { for (const s of [app, shellApi, desktop]) s.close(); });

function get(host: string, path = '/', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ port, path, headers: { host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('appHostName parses only {name}--{base}', () => {
  assert.equal(appHostName('notes--10-0-0-2.nip.io:3000'), 'notes');
  assert.equal(appHostName('10-0-0-2.nip.io:3000'), null);
  assert.equal(appHostName('xn--bcher-kva.example'), null);
  assert.equal(appHostName('aura--x.example'), null);
});

test('the desktop host falls through to the shell', async () => {
  assert.equal((await get('10-0-0-2.nip.io:3000')).body, 'desktop');
});

test('an app host is streamed to the app, untouched, with X-Forwarded-*', async () => {
  const r = await get('notes--10-0-0-2.nip.io:3000', '/api/x?y=1', { 'x-forwarded-proto': 'https' });
  assert.equal(r.status, 200);
  assert.equal(r.body, 'app:/api/x?y=1');
  assert.deepEqual(r.headers['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);   // no path scoping
  const h = seen.at(-1)!.headers;
  assert.equal(h.host, 'notes--10-0-0-2.nip.io:3000');
  assert.equal(h['x-forwarded-host'], 'notes--10-0-0-2.nip.io:3000');
  assert.equal(h['x-forwarded-proto'], 'https');                                // trusted: no AURA_TRUSTED_PROXIES
  assert.equal(h['x-forwarded-port'], '3000');
  assert.equal(h['x-aura-app-id'], 'io.acme.notes');
});

test('a manifest host answers the runtime path itself and drops a forged route header', async () => {
  const before = seen.length;
  const r = await get('notes--desk.example', '/_aura/runtime.js');
  assert.equal(r.status, 200);
  assert.equal(r.body, '');
  assert.match(String(r.headers['content-type']), /javascript/);
  assert.equal(seen.length, before);                            // never reached the app
  await get('notes--desk.example', '/page', { 'x-aura-frame-route': 'host' });
  assert.equal(seen.at(-1)!.headers['x-aura-frame-route'], undefined);
});

test('redirects pass through unchanged', async () => {
  const r = await get('notes--desk.example', '/redirect');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/s/abc');
});

test('an undeclared name falls through to the desktop once the index is loaded', async () => {
  assert.equal((await get('zzz--desk.example')).body, 'desktop');
});

test('a WebSocket upgrade is piped byte for byte', async () => {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  sock.write('GET /ws/room?x=1 HTTP/1.1\r\nHost: notes--desk.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: chat\r\n\r\n');
  let buf = '';
  sock.on('data', (d) => { buf += d; });
  await new Promise((r) => setTimeout(r, 150));
  assert.match(buf, /^HTTP\/1\.1 101/);
  sock.write('ping-bytes');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(buf.endsWith('ping-bytes'));
  sock.destroy();
  const h = seen.at(-1)!;
  assert.equal(h.url, '/ws/room?x=1');
  assert.equal(h.headers['sec-websocket-protocol'], 'chat');
  assert.equal(h.headers.host, 'notes--desk.example');
});

test('a manifest host drops a forged route header on an upgrade', async () => {
  await new Promise<void>((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.on('error', reject);
    sock.once('data', () => { sock.destroy(); resolve(); });
    sock.write('GET /ws HTTP/1.1\r\nHost: notes--desk.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Aura-Frame-Route: host\r\n\r\n');
  });
  assert.equal(seen.at(-1)!.url, '/ws');
  assert.equal(seen.at(-1)!.headers['x-aura-frame-route'], undefined);
});

test('a desktop upgrade still reaches the desktop', async () => {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  sock.write('GET /os-events HTTP/1.1\r\nHost: desk.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  const reply = await new Promise<string>((r) => sock.once('data', (d) => r(String(d))));
  assert.match(reply, /418 Desktop/);
  sock.destroy();
});

test('a sidecar host resolves to aura-<instance>--<service> and the template port', async () => {
  const t = await router.resolve('worker');
  assert.equal(t.host, 'aura-io.acme.notes--worker');
  assert.equal(t.port, 8787);
});

test('a stopped app is started on demand; the browser gets a self-reloading 503', async () => {
  setApps([]);
  const r = await get('notes--desk.example', '/', { accept: 'text/html' });
  assert.equal(r.status, 503);
  assert.equal(r.headers['retry-after'], '2');
  assert.match(r.body, /Starting Notes/);
  await new Promise((res) => setTimeout(res, 100));
  assert.deepEqual(starts, ['POST /api/apps/io.acme.notes/start']);
  await get('notes--desk.example');                     // within the retry window: not asked again
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(starts.length, 1);
});
