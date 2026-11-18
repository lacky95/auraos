// os.flight against a fake OS (local HTTP server): the notify / clearNotice
// calls hit POST /api/activities/<id>/flight/notify with the notice (or null).
//
//   pnpm --filter @aura/app-sdk test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { FlightApi } from '../dist/flight.js';
import { OsClient } from '../dist/OsClient.js';

async function fakeOs(t) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, body: body === '' ? undefined : JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ activityId: 'a1', notice: seen.at(-1).body, flight: { mode: 'free', rect: null, anchor: { edge: 'right', pos: 0.5 }, folded: true, edgeSize: { length: 480, depth: 360 }, perch: { edge: 'right', pos: 0.5 }, notice: seen.at(-1).body } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

test('notify posts the notice; clearNotice posts null; the handle keeps the returned state', async (t) => {
  const os = await fakeOs(t);
  process.env.OS_API_BASE = os.base;
  const f = new FlightApi(new OsClient()).get('a1');
  const st = await f.notify({ level: 'attention', text: 'Koch: hi', count: 3, blink: 2 });
  assert.equal(os.seen[0].method, 'POST');
  assert.equal(os.seen[0].url, '/api/activities/a1/flight/notify');
  assert.deepEqual(os.seen[0].body, { level: 'attention', text: 'Koch: hi', count: 3, blink: 2 });
  assert.equal(st.notice.level, 'attention');
  assert.equal(f.flight?.notice?.count, 3);
  await f.clearNotice();
  assert.equal(os.seen[1].body, null);
  assert.equal(f.flight?.notice, null);
});
