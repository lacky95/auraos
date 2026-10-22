// os.notifications against a fake OS (local HTTP server): the Bearer on
// Node, NO token in a (simulated) browser, sender-token memory, the
// waitForAnswer long-poll, the SSE parser + Last-Event-ID resume, and the
// sendNotification shortcut.
//
//   pnpm --filter @aura/app-sdk test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { NotificationsApi, NotificationsError, parseSse } from '../dist/notifications.js';
import { OsClient } from '../dist/OsClient.js';

async function fakeOs(t, handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const rec = {
      method: req.method, url: req.url, auth: req.headers.authorization,
      senderToken: req.headers['x-aura-sender-token'], lastEventId: req.headers['last-event-id'],
      body: body ? JSON.parse(body) : undefined,
    };
    seen.push(rec);
    const out = await handler(rec, res);
    if (out === 'handled') return;
    const [status, data] = out;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

const item = (over = {}) => ({ id: 'ntf_000000001abcd1234', type: 'simple', title: 't', text: '', state: 'active', sender: { kind: 'app', attribution: 'verified' }, senderKey: 'app:a.b', history: [], ...over });

test('Node: every call carries Authorization: Bearer $AURA_INSTANCE_TOKEN; routes and bodies', async (t) => {
  const os = await fakeOs(t, ({ method, url }) => {
    if (method === 'POST' && url === '/api/notifications') return [201, { ok: true, notification: item(), senderToken: 'nst_x', warnings: [{ code: 'downgraded', field: 'type', message: 'm' }] }];
    if (method === 'PATCH') return [200, { notification: item({ title: 'u' }), warnings: [] }];
    if (url.endsWith('/remove')) return [200, item({ state: 'removed', removedReason: 'completed' })];
    if (url.startsWith('/api/notifications?')) return [200, { items: [item()] }];
    if (url === '/api/notifications/ntf_missing0000000') return [404, { error: 'notification not found' }];
    return [200, item()];
  });
  const n = new NotificationsApi({ base: os.base, token: 'tok' });
  const c = await n.create({ type: 'locked', title: 'x', context: { kind: 'task', id: 't1' } });
  assert.equal(c.notification.id, 'ntf_000000001abcd1234');
  assert.equal(c.warnings[0].code, 'downgraded', 'downgrade warnings reach the caller');
  assert.equal('ok' in c, false);
  await n.update(c.notification.id, { text: 'progress', components: [{ kind: 'progress', value: 0.5 }] });
  assert.equal((await n.get(c.notification.id)).id, c.notification.id);
  assert.equal(await n.get('ntf_missing0000000'), null);
  assert.equal((await n.list({ state: 'all', limit: 5 })).items.length, 1);
  await n.remove(c.notification.id);
  assert.ok(os.seen.every((r) => r.auth === 'Bearer tok'), 'Bearer on every call');
  assert.deepEqual(os.seen.map((r) => `${r.method} ${r.url}`), [
    'POST /api/notifications',
    'PATCH /api/notifications/ntf_000000001abcd1234',
    'GET /api/notifications/ntf_000000001abcd1234',
    'GET /api/notifications/ntf_missing0000000',
    'GET /api/notifications?state=all&limit=5',
    'POST /api/notifications/ntf_000000001abcd1234/remove',
  ]);
  assert.deepEqual(os.seen[0].body, { type: 'locked', title: 'x', context: { kind: 'task', id: 't1' } });
  // the remembered senderToken is sent along on update/remove
  assert.equal(os.seen[1].senderToken, 'nst_x');
  assert.equal(os.seen[5].senderToken, 'nst_x');
});

test('Node: the token comes from AURA_INSTANCE_TOKEN; errors map to NotificationsError', async (t) => {
  const os = await fakeOs(t, () => [403, { error: 'not allowed to send notifications: x does not declare system.notifications' }]);
  process.env.AURA_INSTANCE_TOKEN = 'envtok';
  t.after(() => { delete process.env.AURA_INSTANCE_TOKEN; });
  const n = new NotificationsApi({ base: os.base });
  await assert.rejects(n.create({ title: 'x' }), (err) => err instanceof NotificationsError && err.status === 403 && /system\.notifications/.test(err.message));
  assert.equal(os.seen[0].auth, 'Bearer envtok');
});

test('browser: never sends the instance token, even when one is in the env', async (t) => {
  const os = await fakeOs(t, ({ method }) => (method === 'POST'
    ? [201, { ok: true, notification: item({ sender: { kind: 'app', attribution: 'unverified' } }), senderToken: 'nst_b', warnings: [] }]
    : [200, { notification: item(), warnings: [] }]));
  process.env.AURA_INSTANCE_TOKEN = 'secret-token';
  globalThis.window = {};
  t.after(() => { delete globalThis.window; delete process.env.AURA_INSTANCE_TOKEN; });
  const n = new NotificationsApi({ base: os.base, token: 'also-ignored' });
  const c = await n.create({ title: 'from the page' });
  await n.update(c.notification.id, { title: 'again' });
  assert.equal(os.seen[0].auth, undefined);
  assert.equal(os.seen[1].auth, undefined);
  assert.equal(os.seen[1].senderToken, 'nst_b', 'the unverified creator still manages its own via the senderToken');
});

test('waitForAnswer: long-polls until resolved; pending after the timeout', async (t) => {
  let polls = 0;
  const os = await fakeOs(t, ({ url }) => {
    if (url.includes('ntf_pending')) return [200, item({ id: 'ntf_pending' })];
    polls++;
    return [200, polls < 3 ? item() : item({ state: 'resolved', answer: { choice: 'yes' } })];
  });
  const n = new NotificationsApi({ base: os.base, token: 'tok' });
  const r = await n.waitForAnswer('ntf_000000001abcd1234', { timeoutMs: 60_000 });
  assert.equal(r.status, 'resolved');
  assert.deepEqual(r.answer, { choice: 'yes' });
  assert.equal(polls, 3);
  assert.ok(os.seen.every((s) => /waitFor=resolved&timeout=\d+$/.test(s.url) && Number(s.url.split('timeout=')[1]) <= 25));
  const p = await n.waitForAnswer('ntf_pending', { timeoutMs: 0 });
  assert.equal(p.status, 'pending');
  assert.equal(os.seen.at(-1).url.endsWith('timeout=0'), true);
});

test('waitForInteraction: returns the next interaction, keeps the baseline across polls, ends on resolve', async (t) => {
  let polls = 0;
  const li = (at) => ({ componentId: 'ping', kind: 'button', at, actor: { kind: 'user' } });
  const os = await fakeOs(t, ({ url }, res) => {
    if (url.includes('ntf_done')) return [200, item({ id: 'ntf_done', state: 'resolved', answer: { outcome: 'cancelled' }, outcome: 'cancelled' })];
    polls++;
    const body = polls < 3 ? item({ lastInteraction: li(100) }) : item({ lastInteraction: li(200) });
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Aura-Wait-Reason': polls < 3 ? 'timeout' : 'interaction' });
    res.end(JSON.stringify(body));
    return 'handled';
  });
  const n = new NotificationsApi({ base: os.base, token: 'tok' });
  const r = await n.waitForInteraction('ntf_000000001abcd1234', { timeoutMs: 60_000 });
  assert.equal(r.status, 'interaction');
  assert.equal(r.interaction.at, 200);
  assert.equal(polls, 3);
  assert.ok(/waitFor=interaction&timeout=\d+$/.test(os.seen[0].url), 'first poll lets the server pick the baseline');
  assert.ok(os.seen.slice(1).every((s) => s.url.endsWith('&after=100')), 'later polls pin the baseline');
  const p = await n.waitForInteraction('ntf_000000001abcd1234', { timeoutMs: 0, after: 300 });
  assert.equal(p.status, 'pending');
  const d = await n.waitForInteraction('ntf_done', { after: 0 });
  assert.equal(d.status, 'resolved');
  assert.equal(d.outcome, 'cancelled');
});

test('waitForAnswer: a force-removed Locked notification reports removedReason; blocking/scope pass through on create', async (t) => {
  const os = await fakeOs(t, ({ method }) => (method === 'POST'
    ? [201, { ok: true, notification: item({ type: 'dialogue', blocking: false, scope: 'auto' }), warnings: [{ code: 'downgraded', field: 'scope', from: 'desktop', to: 'auto', message: 'desktop-wide dialogues are reserved for AuraOS system decisions' }] }]
    : [200, item({ type: 'locked', state: 'removed', removedReason: 'force-removed' })]));
  const n = new NotificationsApi({ base: os.base, token: 'tok' });
  const c = await n.create({ type: 'dialogue', title: 'q', blocking: true, scope: 'desktop', context: { kind: 'activity', id: 'a.b-1#a1' } });
  assert.deepEqual(os.seen[0].body, { type: 'dialogue', title: 'q', blocking: true, scope: 'desktop', context: { kind: 'activity', id: 'a.b-1#a1' } });
  assert.equal(c.warnings[0].field, 'scope');
  const r = await n.waitForAnswer('ntf_000000001abcd1234', { timeoutMs: 1000 });
  assert.equal(r.status, 'removed');
  assert.equal(r.removedReason, 'force-removed');
  assert.equal(r.notification.removedReason, 'force-removed');
});

test('parseSse: ids, multi-line data, comments, CRLF, chunk boundaries; an unterminated event is dropped', async () => {
  const text = ': ok\n\nid: 1-0\ndata: {"a":1}\n\n: hb\r\nid: 2-0\r\ndata: line1\r\ndata: line2\r\n\r\ndata: tail';
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream({
    start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); },
  });
  const got = [];
  await parseSse(stream, (data, id) => got.push([data, id]));
  assert.deepEqual(got, [['{"a":1}', '1-0'], ['line1\nline2', '2-0']]);
});

test('subscribe (Node): Bearer, events in order, resumes with Last-Event-ID after a drop; unknown types pass through', async (t) => {
  let conn = 0;
  const os = await fakeOs(t, (rec, res) => {
    if (!rec.url.startsWith('/api/notifications/stream')) return [404, {}];
    conn++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (conn === 1) {
      res.write(': ok\n\n');
      res.write(`id: 5-0\ndata: ${JSON.stringify({ type: 'notification:created', eventId: '5-0', id: 'ntf_a', state: 'active', notification: item() })}\n\n`);
      res.write(`id: 6-0\ndata: ${JSON.stringify({ type: 'notification:interacted', eventId: '6-0', id: 'ntf_a', state: 'active' })}\n\n`);
      res.end(); // drop
    } else {
      res.write(`id: 7-0\ndata: ${JSON.stringify({ type: 'notification:resolved', eventId: '7-0', id: 'ntf_a', state: 'resolved', notification: item({ state: 'resolved', answer: 1 }) })}\n\n`);
    }
    return 'handled';
  });
  const n = new NotificationsApi({ base: os.base, token: 'tok' });
  const events = [];
  await new Promise((resolve) => {
    const stop = n.subscribe((ev) => {
      events.push(ev);
      if (ev.type === 'notification:resolved') { stop(); resolve(); }
    }, { since: '4-0' });
  });
  assert.deepEqual(events.map((e) => e.type), ['notification:created', 'notification:interacted', 'notification:resolved']);
  const streams = os.seen.filter((s) => s.url.startsWith('/api/notifications/stream'));
  assert.equal(streams[0].auth, 'Bearer tok');
  assert.equal(streams[0].lastEventId, '4-0', 'initial since → Last-Event-ID');
  assert.equal(streams[1].lastEventId, '6-0', 'reconnect resumes after the last event seen');
});

test('OsClient: os.notifications is mounted; sendNotification is the Simple shortcut and works in a browser', async (t) => {
  const os = await fakeOs(t, () => [201, { ok: true, notification: item(), warnings: [] }]);
  process.env.OS_API_BASE = os.base;
  process.env.AURA_INSTANCE_TOKEN = 'tok';
  t.after(() => { delete process.env.OS_API_BASE; delete process.env.AURA_INSTANCE_TOKEN; });
  const client = new OsClient();
  assert.ok(client.notifications instanceof NotificationsApi);
  const r = await client.sendNotification('Hi', 'there');
  assert.equal(r.notification.id, 'ntf_000000001abcd1234');
  assert.deepEqual(os.seen[0].body, { type: 'simple', title: 'Hi', text: 'there' });
  assert.equal(os.seen[0].auth, 'Bearer tok');

  // simulated browser: no `process`-only crash, no token
  globalThis.window = { location: { origin: os.base }, addEventListener() {}, removeEventListener() {} };
  t.after(() => { delete globalThis.window; });
  const b = new OsClient();
  b.notifications['opts'].base = os.base; // a real browser uses '' (same origin)
  await b.sendNotification('page');
  assert.equal(os.seen[1].auth, undefined);
});

test('waitForAnswer: reports the outcome (cancelled / submitted; legacy resolve → submitted); role buttons pass through', async (t) => {
  let n = 0;
  const os = await fakeOs(t, ({ method }) => {
    if (method === 'POST') return [201, { ok: true, notification: item({ type: 'dialogue' }), warnings: [] }];
    n++;
    if (n === 1) return [200, item({ state: 'resolved', outcome: 'cancelled', answer: { outcome: 'cancelled', buttonId: 'cancel' } })];
    return [200, item({ state: 'resolved', answer: { buttonId: 'yes' } })];
  });
  const api = new NotificationsApi({ base: os.base, token: 'tok' });
  await api.create({ type: 'dialogue', title: 'q', components: [{ kind: 'button', role: 'cancel', label: 'No thanks' }, { kind: 'button', role: 'submit' }] });
  assert.deepEqual(os.seen[0].body.components, [{ kind: 'button', role: 'cancel', label: 'No thanks' }, { kind: 'button', role: 'submit' }]);
  const a = await api.waitForAnswer('ntf_000000001abcd1234', { timeoutMs: 1000 });
  assert.equal(a.status, 'resolved');
  assert.equal(a.outcome, 'cancelled');
  const b = await api.waitForAnswer('ntf_000000001abcd1234', { timeoutMs: 1000 });
  assert.equal(b.outcome, 'submitted', 'older items without an outcome count as submitted');
});
