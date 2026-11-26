// H4 stopgap: the Terminal's server answers only the shell and its own
// container. Every legitimate path (the shell's proxy, its App Host, the
// Terminal's own tools on loopback) keeps working; another container on
// aura-net is refused, on HTTP (MCP, session API) and on the PTY upgrade.
// D89 B4: a call from the shell's address carries the shell's relay claim;
// warn (default) serves one without it, strict refuses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.OS_API_BASE = 'http://10.9.9.2:3000';
process.env.APP_INSTANCE_ID = 'com.aura.terminal-7';
process.env.AURA_LIFECYCLE_TOKEN = 'test-lifecycle-token';
delete process.env.AURA_RELAY_STRICT;
const { onRequest } = await import('../src/middleware.ts');
const { relayKey, signRelayClaim, RELAY_CLAIM_HEADER } = await import('@aura/app-sdk/relay-claim');

const ctx = (clientAddress, path = '/mcp/terminal', headers = {}, method = 'GET') => ({
  clientAddress, url: new URL(`http://t${path}`), request: new Request(`http://t${path}`, { method, headers }),
});
const next = async () => new Response('ok');
const claim = (path, { method = 'GET', instance = 'com.aura.terminal-7', token = 'test-lifecycle-token' } = {}) =>
  ({ [RELAY_CLAIM_HEADER]: signRelayClaim(relayKey(token), { i: instance, m: method, p: path, u: 'owner-1', c: 'user' }) });

test('HTTP: the shell and loopback pass, another container is refused 403', async () => {
  assert.equal(await (await onRequest(ctx('10.9.9.2'), next)).text(), 'ok', 'the shell (proxy, App Host), warn mode');
  assert.equal(await (await onRequest(ctx('127.0.0.1', '/api/pty-ready'), next)).text(), 'ok', 'the Terminal itself');
  const other = await onRequest(ctx('10.9.9.7', '/api/sessions/input'), next);
  assert.equal(other.status, 403);
  assert.equal((await other.json()).error, 'shell-only');
  const forged = await onRequest(ctx('10.9.9.7', '/mcp/terminal', claim('/mcp/terminal')), next);
  assert.equal(forged.status, 403, 'a claim never makes another address the shell');
  const none = await onRequest({ get clientAddress() { throw new Error('no adapter'); }, url: new URL('http://t/mcp'), request: new Request('http://t/mcp') }, next);
  assert.equal(none.status, 403);
});

test('D89 B4 strict: the shell\'s address needs a valid relay claim for this instance, call and start', async () => {
  process.env.AURA_RELAY_STRICT = 'strict';
  try {
    assert.equal((await onRequest(ctx('10.9.9.2', '/mcp/terminal'), next)).status, 403, 'no claim');
    assert.equal(await (await onRequest(ctx('10.9.9.2', '/mcp/terminal?x=1', claim('/mcp/terminal?x=1', { method: 'POST' }), 'POST'), next)).text(), 'ok', 'a valid claim');
    assert.equal((await onRequest(ctx('10.9.9.2', '/api/sessions/input', claim('/mcp/terminal')), next)).status, 403, 'another path');
    assert.equal((await onRequest(ctx('10.9.9.2', '/mcp/terminal', claim('/mcp/terminal', { method: 'POST' })), next)).status, 403, 'another method');
    assert.equal((await onRequest(ctx('10.9.9.2', '/mcp/terminal', claim('/mcp/terminal', { instance: 'com.aura.terminal-8' })), next)).status, 403, 'another instance');
    assert.equal((await onRequest(ctx('10.9.9.2', '/mcp/terminal', claim('/mcp/terminal', { token: 'an-earlier-start' })), next)).status, 403, 'another start');
    assert.equal(await (await onRequest(ctx('127.0.0.1', '/api/pty-ready'), next)).text(), 'ok', 'the Terminal itself needs none');
  } finally {
    delete process.env.AURA_RELAY_STRICT;
  }
});

test('PTY: both upgrade paths (production server.mjs, dev astro.config.mjs) check the relay before the upgrade', () => {
  for (const f of ['../server.mjs', '../astro.config.mjs']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    const check = src.indexOf('await shellRelayed(req)');
    const upgrade = src.search(/handleUpgrade\(req, socket, head/);
    assert.ok(check > 0 && upgrade > check, `${f}: shellRelayed before handleUpgrade`);
    assert.ok(src.includes('checkShellRelay({'), `${f}: shellRelayed uses app-sdk checkShellRelay`);
  }
});
