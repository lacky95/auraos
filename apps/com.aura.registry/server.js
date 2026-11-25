/**
 * com.aura.registry — tiny wrapper around the in-container zot daemon.
 *
 * What this is and is NOT:
 *   • IS: an AuraOS lifecycle adapter. zot only speaks the OCI Distribution
 *     API (/v2/…) and a couple of admin endpoints; the AppManager polls
 *     /api/lifecycle/health and POSTs /api/lifecycle/{on*}. This file
 *     handles those, then forwards everything else (the /v2/… traffic
 *     callers actually want) to the local zot on 127.0.0.1:5000.
 *   • NOT: a feature-rich proxy. It's pure node:http — no Express, no
 *     middleware, no deps. Streams bidirectionally so blob uploads/downloads
 *     don't buffer in memory.
 *
 * Identity headers (`X-Aura-App-Id`, `X-Aura-Instance-Id`) are stamped on
 * every response so the shell's iframe-identity guard accepts our traffic
 * (same contract the whisper app follows).
 */

const http = require('node:http');
const { createHash, timingSafeEqual } = require('node:crypto');

const APP_ID       = process.env.APP_ID          || 'com.aura.registry';
const INSTANCE_ID  = process.env.APP_INSTANCE_ID || APP_ID;
const APP_PORT     = Number(process.env.APP_PORT || 4090);
const ZOT_HOST     = '127.0.0.1';
const ZOT_PORT     = 5000;

const startedAt = Date.now();

function stampIdentity(res) {
  res.setHeader('X-Aura-App-Id',      APP_ID);
  res.setHeader('X-Aura-Instance-Id', INSTANCE_ID);
}

function jsonReply(res, status, body) {
  stampIdentity(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ─── Lifecycle ─────────────────────────────────────────────────────────
// Mirror the contract every Aura app honours. Health is read-only, the
// six lifecycle POSTs are noops (zot has no per-launch teardown to do —
// killing the container is enough; AppManager's onDestroy → SIGKILL).
const LIFECYCLE_HOOKS = ['onCreate','onStart','onResume','onPause','onStop','onDestroy'];

// The kernel's per-start lifecycle secret: every /api/lifecycle/* call needs
// it in `x-aura-lifecycle`, except a health probe that sends no token (a
// wrong one is refused). The same rule as the SDK's runtime/lifecycle-guard,
// inline because this server has no dependencies.
const LIFECYCLE_TOKEN = process.env.AURA_LIFECYCLE_TOKEN || '';
const sha256 = (v) => createHash('sha256').update(String(v)).digest();

/** The normalized path under /api/lifecycle, or null (as the SDK's hostRules). */
function lifecyclePathOf(url) {
  let p;
  try { p = decodeURIComponent(url.split(/[?#]/, 1)[0]); }
  catch { return /^[/\\]+api[/\\]/i.test(url) ? '/api/lifecycle/?' : null; }
  p = new URL(`/${p.replace(/\\/g, '/')}`.replace(/\/{2,}/g, '/'), 'http://h').pathname.toLowerCase().replace(/\/+$/, '');
  return p === '/api/lifecycle' || p.startsWith('/api/lifecycle/') ? p : null;
}

function lifecycleRefused(req, url) {
  const route = lifecyclePathOf(url);
  if (route === null || !LIFECYCLE_TOKEN) return false;
  const presented = req.headers['x-aura-lifecycle'];
  if (presented === undefined) return route !== '/api/lifecycle/health';
  return typeof presented !== 'string' || !timingSafeEqual(sha256(presented), sha256(LIFECYCLE_TOKEN));
}

function handleLifecycle(req, res, url) {
  if (lifecycleRefused(req, url)) {
    return jsonReply(res, 401, { ok: false, error: 'lifecycle-token-required' });
  }
  if (req.method === 'GET' && url === '/api/lifecycle/health') {
    return jsonReply(res, 200, {
      ok: true, appId: APP_ID, instanceId: INSTANCE_ID,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    });
  }
  for (const hook of LIFECYCLE_HOOKS) {
    if (req.method === 'POST' && url === `/api/lifecycle/${hook}`) {
      return jsonReply(res, 200, { ok: true });
    }
  }
  return false;
}

// ─── Forward to zot ────────────────────────────────────────────────────
// node:http.request gives us a full duplex stream — pipe the request body
// in, pipe the response back, copy headers + status verbatim. Necessary
// for /v2/<name>/blobs/uploads/ which can be hundreds of MB.
function proxyToZot(req, res) {
  const opts = {
    hostname: ZOT_HOST,
    port:     ZOT_PORT,
    method:   req.method,
    path:     req.url,
    headers:  { ...req.headers, host: `${ZOT_HOST}:${ZOT_PORT}` },
  };
  const upstream = http.request(opts, (upRes) => {
    stampIdentity(res);
    // Copy ALL headers (incl. Docker-Content-Digest, Location, etc. —
    // OCI clients rely on these for resumable uploads + digest verify).
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (v !== undefined) res.setHeader(k, v);
    }
    res.writeHead(upRes.statusCode || 502);
    upRes.pipe(res);
  });
  upstream.on('error', (err) => {
    console.error('[registry] upstream zot error:', err.message);
    if (!res.headersSent) {
      jsonReply(res, 502, { error: 'zot unreachable', detail: err.message });
    } else {
      res.destroy();
    }
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (handleLifecycle(req, res, url) !== false) return;
  proxyToZot(req, res);
});

server.listen(APP_PORT, '0.0.0.0', () => {
  console.log(`[registry] wrapper listening on :${APP_PORT} (forwarding to zot ${ZOT_HOST}:${ZOT_PORT})`);
  console.log(`[registry] appId=${APP_ID} instanceId=${INSTANCE_ID}`);
});
