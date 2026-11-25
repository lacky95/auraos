// H4 stopgap: the Terminal's server answers only the shell and its own
// container. Every legitimate path (the shell's proxy, its App Host, the
// Terminal's own tools on loopback) keeps working; another container on
// aura-net is refused, on HTTP (MCP, session API) and on the PTY upgrade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.OS_API_BASE = 'http://10.9.9.2:3000';
const { onRequest } = await import('../src/middleware.ts');

const ctx = (clientAddress, path = '/mcp/terminal') => ({ clientAddress, url: new URL(`http://t${path}`) });
const next = async () => new Response('ok');

test('HTTP: the shell and loopback pass, another container is refused 403', async () => {
  assert.equal(await (await onRequest(ctx('10.9.9.2'), next)).text(), 'ok', 'the shell (proxy, App Host)');
  assert.equal(await (await onRequest(ctx('127.0.0.1', '/api/pty-ready'), next)).text(), 'ok', 'the Terminal itself');
  const other = await onRequest(ctx('10.9.9.7', '/api/sessions/input'), next);
  assert.equal(other.status, 403);
  assert.equal((await other.json()).error, 'shell-only');
  const none = await onRequest({ get clientAddress() { throw new Error('no adapter'); }, url: new URL('http://t/mcp') }, next);
  assert.equal(none.status, 403);
});

test('PTY: both upgrade paths (production server.mjs, dev astro.config.mjs) check the peer before the upgrade', () => {
  for (const f of ['../server.mjs', '../astro.config.mjs']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    const check = src.indexOf('await fromShell(req.socket.remoteAddress)');
    const upgrade = src.search(/handleUpgrade\(req, socket, head/);
    assert.ok(check > 0 && upgrade > check, `${f}: fromShell before handleUpgrade`);
  }
});
