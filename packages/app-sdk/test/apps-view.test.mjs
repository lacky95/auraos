// D104 `osClient.apps.view`: the delegation credential stays on the server
// and on the target's host. A fake OS (handoff route + App Host) and an
// "elsewhere" server that must never see the cookie.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

const TARGET_HOST = 'sentinel1--desk.example';
const elsewhereSeen = [];
const elsewhere = http.createServer((req, res) => { elsewhereSeen.push(req.headers); res.end('elsewhere'); });
const elsewherePort = await listen(elsewhere);

const osSeen = [];
let grantAsks = 0;
const os = http.createServer((req, res) => {
  osSeen.push({ method: req.method, url: req.url, headers: req.headers });
  if (req.url === '/api/app-hosts/view') {
    grantAsks += 1;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const t = JSON.parse(body);
      if (t.appId === 'com.aura.settings') {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          error: 'access-denied', reason: 'wrong-target', message: "com.aura.settings is the owner's", hint: 'Open it as its own window instead (an intent).',
          permission: 'apps.view', target: 'com.aura.settings', docs: '/docs/app-composition#target-not-allowed',
        }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: `http://${TARGET_HOST}/_aura/handoff?code=${'c'.repeat(43)}`, origin: `http://${TARGET_HOST}`, host: TARGET_HOST, appId: 'com.aura.sentinel', expiresAt: Date.now() + 600_000 }));
    });
    return;
  }
  if (req.headers.host !== TARGET_HOST) { res.writeHead(404); return res.end(); }
  if (req.url.startsWith('/_aura/handoff')) {
    res.writeHead(303, { location: '/', 'set-cookie': 'aura_app_view=SECRETVALUE; Path=/; HttpOnly; SameSite=Lax' });
    return res.end();
  }
  if (req.url === '/redirect') {
    res.writeHead(302, { location: `http://127.0.0.1:${elsewherePort}/steal`, 'set-cookie': 'own=1' });
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'aura_app_view=x' });
  res.end(`page ${req.url}`);
});
const osPort = await listen(os);

let OsClient;
before(async () => {
  process.env.OS_API_BASE = `http://127.0.0.1:${osPort}`;
  process.env.AURA_INSTANCE_TOKEN = 'aura1.test-token';
  ({ OsClient } = await import('../dist/index.js'));
});
after(() => { for (const s of [os, elsewhere]) { s.closeAllConnections?.(); s.close(); } });

test('a view reads its target with the restricted cookie, on the target host only', async () => {
  const client = new OsClient();
  const v = await client.apps.view({ appId: 'com.aura.sentinel', desktop: 'desk.example' });
  assert.equal(v.host, TARGET_HOST);
  const r = await v.fetch('/api/findings?x=1');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'page /api/findings?x=1');
  const sent = osSeen.at(-1);
  assert.equal(sent.headers.host, TARGET_HOST);
  assert.equal(sent.headers.cookie, 'aura_app_view=SECRETVALUE');
  assert.equal(sent.headers.authorization, undefined, 'the instance token never goes to the target');
  assert.equal(r.headers.get('set-cookie'), null, 'no cookie handed back to the caller');
});

test('the credential never leaves for another host: no absolute URL, no redirect followed', async () => {
  const v = await new OsClient().apps.view({ host: TARGET_HOST });
  for (const bad of [`http://127.0.0.1:${elsewherePort}/x`, `//127.0.0.1:${elsewherePort}/x`, '\\\\evil/x', 'relative', '/a b']) {
    await assert.rejects(() => v.fetch(bad), (e) => e.code === 'invalid-request', bad);
  }
  const r = await v.fetch('/redirect');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /\/steal$/);
  assert.equal(elsewhereSeen.length, 0, 'the redirect was not followed');
  // Headers the caller passes cannot replace the credential or the host.
  await v.fetch('/p', { headers: { cookie: 'aura_app=stolen', host: 'evil.example', Authorization: 'Bearer x' } });
  const sent = osSeen.at(-1);
  assert.equal(sent.headers.host, TARGET_HOST);
  assert.equal(sent.headers.cookie, 'aura_app_view=SECRETVALUE');
  assert.equal(sent.headers.authorization, undefined);
});

test('writes are refused before anything is sent', async () => {
  const v = await new OsClient().apps.view({ host: TARGET_HOST });
  const before = osSeen.length;
  await assert.rejects(() => v.fetch('/api/x', { method: 'POST' }), (e) => e.code === 'access-denied' && /read-only/.test(e.message));
  assert.equal(osSeen.length, before);
});

test('a refusal is an OsError with the hint and the facts', async () => {
  await assert.rejects(() => new OsClient().apps.view({ appId: 'com.aura.settings', desktop: 'desk.example' }), (e) => {
    assert.equal(e.status, 403);
    assert.equal(e.code, 'access-denied');
    assert.equal(e.reason, 'wrong-target');
    assert.equal(e.permission, 'apps.view');
    assert.equal(e.target, 'com.aura.settings');
    assert.match(e.hint, /own window/);
    assert.match(e.message, / — Open it as its own window/);
    return true;
  });
});
