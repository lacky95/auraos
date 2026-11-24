/**
 * Server half of the EventSource multiplexer, behind the App Host gateway
 * (`/_aura/os/sse-mux`, app-gateway.mjs).
 *
 * Browsers open at most 6 HTTP/1.1 connections per host. An EventSource holds
 * its connection for as long as the window lives, so a handful of streaming
 * windows exhausts the pool: every later request queues forever and the
 * window never leaves its loading skeleton.
 *
 * WebSockets don't draw from that pool. `/_aura/runtime.js` replaces
 * `EventSource` for the shell's streams with one that sends them over one
 * WebSocket. Here each stream is opened as a server-side fetch with the URL
 * and headers the gateway's scope allows, its SSE framing is parsed and its
 * events are relayed as JSON frames. The client reproduces EventSource
 * semantics (readyState, reconnect with Last-Event-ID, `retry:`).
 *
 * Wire protocol (JSON text frames):
 *   client → server  {op:'open', id, url, lastEventId?}   url: a shell path
 *                    {op:'close', id}
 *   server → client  {op:'open', id}                      upstream answered 200 text/event-stream
 *                    {op:'event', id, type, data, lastEventId}
 *                    {op:'retry', id, ms}
 *                    {op:'end', id}                        stream dropped; client reconnects
 *                    {op:'fail', id, status}               bad response; client closes for good
 */

import { reportSurface, surfaceIdentity } from './access-bridge.mjs';

const PING_MS = 25_000;
const MAX_STREAMS_PER_SOCKET = 256;

/**
 * Incremental SSE parser per the WHATWG EventSource spec: `data` lines join
 * with "\n", a blank line dispatches, `id` sticks across events, `retry`
 * takes integer milliseconds, comment lines (":") are ignored.
 */
export function createSseParser(onEvent, onRetry) {
  let buf = '';
  let data = [];
  let type = '';
  let lastEventId = '';
  let firstChunk = true;

  const dispatch = () => {
    if (data.length) onEvent({ type: type || 'message', data: data.join('\n'), lastEventId });
    data = [];
    type = '';
  };

  const line = (l) => {
    if (l === '') { dispatch(); return; }
    if (l.startsWith(':')) return;
    const colon = l.indexOf(':');
    const field = colon === -1 ? l : l.slice(0, colon);
    let value = colon === -1 ? '' : l.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') type = value;
    else if (field === 'id') { if (!value.includes('\0')) lastEventId = value; }
    else if (field === 'retry') { if (/^\d+$/.test(value)) onRetry(Number(value)); }
  };

  return (chunk) => {
    buf += chunk;
    if (firstChunk && buf.length) {
      if (buf.charCodeAt(0) === 0xfeff) buf = buf.slice(1);
      firstChunk = false;
    }
    let i;
    while ((i = buf.search(/\r\n|\r|\n/)) !== -1) {
      // A lone trailing "\r" may be the first half of "\r\n"; wait for more.
      if (buf[i] === '\r' && i === buf.length - 1) break;
      const nl = buf[i] === '\r' && buf[i + 1] === '\n' ? 2 : 1;
      line(buf.slice(0, i));
      buf = buf.slice(i + nl);
    }
  };
}

/**
 * The mux. `serveScoped` takes over an upgrade the gateway checked;
 * `scope.stream(rawUrl)` returns the one URL and headers a stream may use, or
 * null. Nothing from the upgrade request is sent upstream.
 * @param log  optional debug logger (tag, ...args)
 */
export async function createSseMux(log = () => {}) {
  const { WebSocketServer, WebSocket } = await import('ws');
  const wss = new WebSocketServer({ noServer: true });

  function serve(ws, req, scope) {
    const streams = new Map(); // id → AbortController
    log('connect', req.socket.remoteAddress);
    const identity = surfaceIdentity(req.headers);
    const reportStream = (method, status) => reportSurface({ subject: 'sse-mux', method, status, via: 'sse-mux', identity });
    reportStream('UPGRADE', 101);

    const send = (msg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    async function open(id, rawUrl, lastEventId) {
      const target = scope.stream(rawUrl);
      const url = target?.url;
      if (!url) { send({ op: 'fail', id, status: 0 }); return; }
      if (streams.size >= MAX_STREAMS_PER_SOCKET) { send({ op: 'fail', id, status: 0 }); return; }
      streams.get(id)?.abort();
      const ctrl = new AbortController();
      streams.set(id, ctrl);
      const headers = { ...target.headers };
      if (lastEventId) headers['last-event-id'] = lastEventId;

      let res;
      try {
        res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'error' });
      } catch (err) {
        if (streams.get(id) !== ctrl) return;
        streams.delete(id);
        reportStream('GET', 0);
        log('fetch-error', rawUrl, String(err));
        send({ op: 'end', id });
        return;
      }
      if (streams.get(id) !== ctrl) { res.body?.cancel().catch(() => {}); return; }
      reportStream('GET', res.status);
      const ct = res.headers.get('content-type') ?? '';
      if (res.status !== 200 || !/^text\/event-stream\b/i.test(ct)) {
        streams.delete(id);
        res.body?.cancel().catch(() => {});
        log('fail', rawUrl, res.status, ct);
        send({ op: 'fail', id, status: res.status });
        return;
      }
      send({ op: 'open', id });
      log('open', id, rawUrl);

      const parse = createSseParser(
        (ev) => send({ op: 'event', id, ...ev }),
        (ms) => send({ op: 'retry', id, ms }),
      );
      const decoder = new TextDecoder();
      try {
        for await (const chunk of res.body) {
          parse(decoder.decode(chunk, { stream: true }));
        }
      } catch { /* aborted or upstream dropped */ }
      if (streams.get(id) === ctrl) {
        streams.delete(id);
        log('end', id, rawUrl);
        send({ op: 'end', id });
      }
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || typeof msg.id !== 'number') return;
      if (msg.op === 'open') void open(msg.id, msg.url, typeof msg.lastEventId === 'string' ? msg.lastEventId : '');
      else if (msg.op === 'close') { streams.get(msg.id)?.abort(); streams.delete(msg.id); }
    });

    // Heartbeat, same reasoning as the WS proxy: a silent socket gets reaped
    // by whatever sits in between, and a dead client must release its streams.
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const hb = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      try { ws.ping(); } catch {}
    }, PING_MS);
    if (typeof hb.unref === 'function') hb.unref();

    ws.on('close', () => {
      clearInterval(hb);
      for (const ctrl of streams.values()) ctrl.abort();
      streams.clear();
      log('disconnect');
    });
  }

  return {
    serveScoped(req, socket, head, scope) {
      wss.handleUpgrade(req, socket, head, (ws) => serve(ws, req, scope));
    },
  };
}
