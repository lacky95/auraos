// The one lifecycle client and health loop (5b plan §3.9 #7, #8; Phase 6
// ari-rest): both runners call it over their destination (PRoot: localhost
// with /proc listener ownership; container: the address bound at spawn).
// Unified behaviour, against a real HTTP server: required hooks throw on an
// unknown or unbound instance and on a non-2xx answer (never sent unbound);
// optional hooks answer JSON or null; the health loop waits, admits only a
// matching identity, fails loud on a refusal or a gone workload, and times
// out with the last body. Per-runtime differences are data (LifecycleTraits).
//
// Run via: node tools/run-tests.mjs --only=core
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  DestinationBindingError, StartupFailure, callOptionalHook, callRequiredHook, lifecycleUrl, waitHealthy,
} from '../dist/app-manager/lifecycleClient.js';
import { StartupFailure as ProotStartupFailure, DestinationBindingError as ProotBindingError } from '../dist/app-manager/ProotRunner.js';

const TRAITS = { name: '[TestRunner]', bootBudgetMs: 1_500, probeTimeoutMs: 500 };

async function server(handler) {
  const seen = [];
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, res, body); });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { port: s.address().port, seen, close: () => new Promise((r) => s.close(r)) };
}
const dest = (port, extra = {}) => ({ host: '127.0.0.1', port, token: 'tok', unbound: () => null, ...extra });

test('lifecycleUrl: one form for both runners; an IPv6 address gets brackets', () => {
  assert.equal(lifecycleUrl('localhost', 4001, 'onStart'), 'http://localhost:4001/api/lifecycle/onStart');
  assert.equal(lifecycleUrl('172.18.0.5', 4001, 'health'), 'http://172.18.0.5:4001/api/lifecycle/health');
  assert.equal(lifecycleUrl('fd00::5', 4001, 'health'), 'http://[fd00::5]:4001/api/lifecycle/health');
  assert.equal(ProotStartupFailure, StartupFailure, 'one definition');
  assert.equal(ProotBindingError, DestinationBindingError, 'one definition');
});

test('required hook: throws for an unknown or unbound instance (never sent) and on non-2xx; carries the token and reason', async () => {
  const s = await server((req, res) => { res.statusCode = req.url.endsWith('onFail') ? 500 : 200; res.end('{}'); });
  try {
    await assert.rejects(callRequiredHook(TRAITS, 'io.t.app-1', null, 'onStart'), /\[TestRunner\] io\.t\.app-1 is not running; onStart not sent/);
    await assert.rejects(callRequiredHook(TRAITS, 'io.t.app-1', dest(s.port, { unbound: () => 'port 1 is not bound to the instance' }), 'onStart'),
      /port 1 is not bound to the instance; onStart not sent/);
    assert.equal(s.seen.length, 0, 'the token never went out');
    await assert.rejects(callRequiredHook(TRAITS, 'io.t.app-1', dest(s.port), 'onFail'), /lifecycle hook onFail returned 500/);
    await callRequiredHook(TRAITS, 'io.t.app-1', dest(s.port), 'onStop', { reason: 'user' });
    const stop = s.seen.at(-1);
    assert.equal(stop.method, 'POST');
    assert.equal(stop.headers['x-aura-lifecycle'], 'tok');
    assert.equal(stop.headers['x-aura-stop-reason'], 'user');
  } finally { await s.close(); }
});

test('optional hook: its JSON answer, else null (unknown, unbound, 404, error status, empty or non-JSON body)', async () => {
  const replies = { '/api/lifecycle/json': [200, '{"ok":true}'], '/api/lifecycle/text': [200, 'plain'], '/api/lifecycle/empty': [200, ''], '/api/lifecycle/err': [500, '{}'] };
  const s = await server((req, res, body) => {
    const [code, out] = replies[req.url] ?? [404, ''];
    res.statusCode = code;
    res.end(req.url.endsWith('echo') ? body : out);
  });
  try {
    assert.deepEqual(await callOptionalHook(TRAITS, dest(s.port), 'json', { a: 1 }), { ok: true });
    assert.equal(s.seen.at(-1).headers['content-type'], 'application/json');
    assert.equal(s.seen.at(-1).body, '{"a":1}');
    for (const hook of ['text', 'empty', 'err', 'missing']) assert.equal(await callOptionalHook(TRAITS, dest(s.port), hook), null, hook);
    assert.equal(await callOptionalHook(TRAITS, null, 'json'), null);
    const before = s.seen.length;
    assert.equal(await callOptionalHook(TRAITS, dest(s.port, { unbound: () => 'foreign' }), 'json'), null);
    assert.equal(s.seen.length, before, 'not sent unbound');
    assert.equal(await callOptionalHook(TRAITS, dest(1), 'json'), null, 'connection refused');
  } finally { await s.close(); }
});

test('health loop: waits while nothing listens, admits the matching identity with the token', async () => {
  const s = await server((_req, res) => res.end(JSON.stringify({ appId: 'io.t.app', instanceId: 'io.t.app-1' })));
  try {
    let polls = 0;
    const kind = await waitHealthy(TRAITS, 'io.t.app-1', 'io.t.app', { next: () => (++polls < 3 ? null : dest(s.port)) });
    assert.equal(kind, 'match');
    assert.ok(polls >= 3);
    assert.equal(s.seen[0].headers['x-aura-lifecycle'], 'tok');
  } finally { await s.close(); }
});

test('health loop: an identity refusal fails at once (DestinationBindingError); a gone workload fails with the runner\'s error', async () => {
  const s = await server((_req, res) => res.end(JSON.stringify({ appId: 'io.other', instanceId: 'io.other-1' })));
  try {
    await assert.rejects(waitHealthy(TRAITS, 'io.t.app-1', 'io.t.app', { next: () => dest(s.port) }),
      (e) => e instanceof DestinationBindingError && /\[TestRunner\] health identity mismatch for io\.t\.app-1/.test(e.message));
    await assert.rejects(waitHealthy(TRAITS, 'io.t.app-1', 'io.t.app', { next: () => { throw new StartupFailure('gone'); } }),
      (e) => e instanceof StartupFailure && e.message === 'gone');
  } finally { await s.close(); }
});

test('health loop: never healthy → StartupFailure after the boot budget, with the last body', async () => {
  const s = await server((_req, res) => { res.statusCode = 403; res.end('host gate'); });
  try {
    await assert.rejects(waitHealthy({ ...TRAITS, bootBudgetMs: 600 }, 'io.t.app-1', 'io.t.app', { next: () => dest(s.port) }),
      (e) => e instanceof StartupFailure && /\[TestRunner\] io\.t\.app-1 did not become healthy within 600ms \(last body: host gate\)/.test(e.message));
    await assert.rejects(waitHealthy({ ...TRAITS, bootBudgetMs: 600 }, 'io.t.app-1', 'io.t.app', {
      next: () => dest(s.port), provision: { isProvisioning: false, everProvisioned: true },
    }), /did not become healthy \d+s after starting to install its dependencies/);
  } finally { await s.close(); }
});
