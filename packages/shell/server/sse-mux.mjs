/**
 * Server half of the EventSource multiplexer.
 *
 * Browsers open at most 6 HTTP/1.1 connections per host, and every AuraOS
 * window shares the shell's host. An EventSource holds its connection for as
 * long as the window lives, so a handful of streaming windows (one per
 * notepad activity, one per SDK `subscribeOsEvents`, …) exhausts the pool:
 * every later request — including a reloaded app's own scripts — queues
 * forever and the window never leaves its loading skeleton.
 *
 * WebSockets don't draw from that pool. The proxy injects a client shim into
 * every app document that replaces `EventSource` for same-origin URLs and
 * sends the stream over one WebSocket to `MUX_PATH`. Here we open each stream
 * as a plain server-side fetch against our own HTTP server — so it still goes
 * through `/api/proxy/...` with the page's cookies — parse the SSE framing and
 * relay events as JSON frames. The client reproduces EventSource semantics
 * (readyState, reconnect with Last-Event-ID, `retry:`), so apps can't tell.
 *
 * Wire protocol (JSON text frames):
 *   client → server  {op:'open', id, url, lastEventId?}   url: path+query, same origin
 *                    {op:'close', id}
 *   server → client  {op:'open', id}                      upstream answered 200 text/event-stream
 *                    {op:'event', id, type, data, lastEventId}
 *                    {op:'retry', id, ms}
 *                    {op:'end', id}                        stream dropped; client reconnects
 *                    {op:'fail', id, status}               bad response; client closes for good
 */

export const MUX_PATH = '/_aura/sse-mux';

const PING_MS = 25_000;
const MAX_STREAMS_PER_SOCKET = 256;

/**
 * Only same-origin absolute paths may be opened: the mux must not become an
 * open relay to arbitrary hosts, so the URL is always resolved against our
 * own loopback origin.
 */
export function toUpstreamUrl(origin, raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return null;
  const u = new URL(raw, origin);
  return u.origin === origin ? u.href : null;
}

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
 * Attach the mux to a Node HTTP server's `upgrade` event.
 * @param httpServer  the shell's HTTP server
 * @param origin      loopback origin streams are fetched from, e.g. http://127.0.0.1:3000
 * @param log         optional debug logger (tag, ...args)
 */
export async function attachSseMux(httpServer, origin, log = () => {}) {
  const { WebSocketServer, WebSocket } = await import('ws');
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== MUX_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => serve(ws, req));
  });

  function serve(ws, req) {
    const streams = new Map(); // id → AbortController
    // Headers every stream carries upstream: the page's cookies and identity,
    // exactly what a native EventSource request from that document would send.
    const baseHeaders = { accept: 'text/event-stream', 'cache-control': 'no-cache' };
    for (const h of ['cookie', 'authorization', 'user-agent', 'accept-language']) {
      if (req.headers[h] != null) baseHeaders[h] = String(req.headers[h]);
    }
    log('connect', req.socket.remoteAddress);

    const send = (msg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    async function open(id, rawUrl, lastEventId) {
      const url = toUpstreamUrl(origin, rawUrl);
      if (!url) { send({ op: 'fail', id, status: 0 }); return; }
      if (streams.size >= MAX_STREAMS_PER_SOCKET) { send({ op: 'fail', id, status: 0 }); return; }
      streams.get(id)?.abort();
      const ctrl = new AbortController();
      streams.set(id, ctrl);
      const headers = { ...baseHeaders };
      if (lastEventId) headers['last-event-id'] = lastEventId;

      let res;
      try {
        res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
      } catch (err) {
        if (streams.get(id) !== ctrl) return;
        streams.delete(id);
        log('fetch-error', rawUrl, String(err));
        send({ op: 'end', id });
        return;
      }
      if (streams.get(id) !== ctrl) { res.body?.cancel().catch(() => {}); return; }
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

  return wss;
}
