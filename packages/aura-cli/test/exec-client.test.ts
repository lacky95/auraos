// Phase 5 stream X: the CLI's exec bridge client (lib/exec-client.ts)
// against a minimal WebSocket server (the CLI has no `ws` dependency): the
// open frame and the instance token on the handshake, stdout and stderr kept
// apart, the exit code, the refusals a caller falls back on, the SSE parser
// of the logs route, and AURA_EXEC_VIA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { EXEC_SUBPROTOCOL, SseParser, execVia, runSession, sessionUrl, type SessionIo } from '../src/lib/exec-client.js';

/** Server → client frame (unmasked). */
function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len])
    : Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff]);
  return Buffer.concat([head, payload]);
}

/** Client → server frames (masked) from a byte stream. */
function parseFrames(buf: Buffer): { frames: Array<{ opcode: number; data: Buffer }>; rest: Buffer } {
  const frames: Array<{ opcode: number; data: Buffer }> = [];
  for (;;) {
    if (buf.length < 2) break;
    const opcode = buf[0]! & 0x0f;
    let len = buf[1]! & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    if (buf.length < off + 4 + len) break;
    const mask = buf.subarray(off, off + 4);
    const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < data.length; i++) data[i]! ^= mask[i % 4]!;
    frames.push({ opcode, data });
    buf = buf.subarray(off + 4 + len);
  }
  return { frames, rest: buf };
}

type Script = (msg: { text?: string; binary?: Buffer }, send: { text(o: unknown): void; binary(ch: number, s: string): void; close(): void }) => void;

async function server(t: { after(fn: () => void): void }, opts: { status?: number; script: Script }) {
  const seen: { headers: http.IncomingHttpHeaders | null; url: string | null } = { headers: null, url: null };
  const srv = http.createServer((_q, r) => { r.statusCode = 404; r.end(); });
  srv.on('upgrade', (req, socket: Socket) => {
    seen.headers = req.headers;
    seen.url = req.url ?? null;
    if (opts.status) { socket.end(`HTTP/1.1 ${opts.status} No\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${EXEC_SUBPROTOCOL}\r\n\r\n`);
    const send = {
      text: (o: unknown) => socket.write(frame(1, Buffer.from(JSON.stringify(o)))),
      binary: (ch: number, s: string) => socket.write(frame(2, Buffer.concat([Buffer.from([ch]), Buffer.from(s)]))),
      close: () => { socket.write(frame(8, Buffer.from([0x03, 0xe8]))); socket.end(); },
    };
    let pending = Buffer.alloc(0);
    socket.on('data', (d: Buffer) => {
      const { frames, rest } = parseFrames(Buffer.concat([pending, d]));
      pending = rest;
      for (const f of frames) {
        if (f.opcode === 1) opts.script({ text: f.data.toString() }, send);
        else if (f.opcode === 2) opts.script({ binary: f.data }, send);
        else if (f.opcode === 8) socket.end();
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen };
}

/** Run with captured stdio and the shell at `base`, as an instance holding its token. */
async function captured<T>(base: string, fn: (io: SessionIo) => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const saved = { ...process.env };
  process.env['AURA_SHELL_URL'] = base;
  process.env['OS_API_BASE'] = base;
  process.env['AURA_INSTANCE_TOKEN'] = 'tok-123';
  process.env['APP_INSTANCE_ID'] = 'com.aura.terminal-1';
  const sink = () => {
    const w = new PassThrough();
    let text = '';
    w.on('data', (d) => { text += d; });
    return { w: w as unknown as NodeJS.WriteStream, text: () => text };
  };
  const out = sink();
  const err = sink();
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  try {
    const result = await fn({ stdin, stdout: out.w, stderr: err.w });
    await new Promise((r) => setImmediate(r));
    return { result, out: out.text(), err: err.text() };
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test('a session: the open frame, the token on the handshake, stdout and stderr apart, the exit code', async (t) => {
  let openFrame: Record<string, unknown> | null = null;
  const s = await server(t, {
    script: (msg, send) => {
      if (!msg.text) return;
      const m = JSON.parse(msg.text);
      if (m.op !== 'open') return;
      openFrame = m;
      send.text({ op: 'opened' });
      send.binary(1, 'hello\n');
      send.binary(2, 'oops\n');
      send.text({ op: 'exit', code: 5 });
      send.close();
    },
  });
  const r = await captured(s.base, (io) => runSession({ instanceId: 'com.acme.notes-1', kind: 'exec', argv: ['ls', '-la'], tty: false }, io));
  assert.deepEqual(r.result, { opened: true, code: 5 });
  assert.equal(r.out, 'hello\n');
  assert.equal(r.err, 'oops\n');
  assert.equal(s.seen.url, '/api/instances/com.acme.notes-1/session');
  assert.equal(s.seen.headers?.['authorization'], 'Bearer tok-123');
  assert.equal(s.seen.headers?.['sec-websocket-protocol'], EXEC_SUBPROTOCOL);
  assert.equal(openFrame!['kind'], 'exec');
  assert.deepEqual(openFrame!['argv'], ['ls', '-la']);
  assert.equal(openFrame!['tty'], false);
  assert.deepEqual(Object.keys(openFrame!['env'] as object).sort(), ['COLORTERM', 'LANG', 'LC_ALL', 'TERM']);
});

test('refusals before the session opens are reported for a fallback', async (t) => {
  const refused = await server(t, { status: 403, script: () => {} });
  const a = await captured(refused.base, (io) => runSession({ instanceId: 'x-1', kind: 'jump', tty: false }, io));
  assert.equal(a.result.opened, false);
  const error = await server(t, {
    script: (msg, send) => { if (msg.text) { send.text({ op: 'error', code: 'runtime-unsupported', message: 'proot' }); send.close(); } },
  });
  const b = await captured(error.base, (io) => runSession({ instanceId: 'x-1', kind: 'jump', tty: false }, io));
  assert.deepEqual(b.result, { opened: false, reason: 'runtime-unsupported: proot' });
  assert.equal(b.out, '');
});

test('sessionUrl, execVia, SseParser', () => {
  assert.equal(sessionUrl('a.b-1', 'https://shell.example:8443'), 'wss://shell.example:8443/api/instances/a.b-1/session');
  assert.equal(sessionUrl('a b', 'http://aura-shell:3000'), 'ws://aura-shell:3000/api/instances/a%20b/session');
  assert.equal(execVia({}), 'auto');
  assert.equal(execVia({ AURA_EXEC_VIA: 'API' }), 'api');
  assert.equal(execVia({ AURA_EXEC_VIA: 'docker' }), 'docker');
  assert.equal(execVia({ AURA_EXEC_VIA: 'x' }), 'auto');
  const got: Array<[string, string]> = [];
  const p = new SseParser((e) => got.push([e.event, e.data]));
  p.push(': ok\n\nevent: out\ndata: "a\\n"\n\nevent: er');
  p.push('r\ndata: "b"\n\n: hb\n\n');
  assert.deepEqual(got, [['out', '"a\\n"'], ['err', '"b"']]);
});
