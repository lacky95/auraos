/**
 * The one HTTP path out of the smoke test, plus a loopback proxy that puts the
 * `aura` CLI behind the same guard.
 *
 * Requests carry no credentials or cookies. Redirects are not followed, because
 * a redirect target would bypass the allowlist. Error details never include a
 * response body.
 */
import { createServer } from 'node:http';

export class GuardViolation extends Error {
  constructor(method, path, reason) {
    super(`refused ${method} ${String(path).split('?')[0]}: ${reason}`);
    this.name = 'GuardViolation';
  }
}

/** Accept an origin only: a path, query or embedded login is a usage error. */
export function normalizeTarget(target) {
  const url = new URL(target);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('--target must be http or https');
  if (url.username || url.password) throw new Error('--target must not contain credentials');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('--target must be an origin, with no path or query');
  }
  return url.origin;
}

export function createClient({ target, guard, fetchImpl = fetch, timeoutMs = 10_000 }) {
  const base = normalizeTarget(target);

  /** Guard first, then send. Throws GuardViolation without touching the network. */
  async function request(method, path) {
    const verdict = guard.check(method, path);
    if (!verdict.ok) throw new GuardViolation(method, path, verdict.reason);
    try {
      const res = await fetchImpl(base + path, {
        method,
        redirect: 'manual',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      return { status: 0, text: '', error: err?.cause?.code ?? err?.name ?? 'network-error' };
    }
  }

  async function getJson(path) {
    const res = await request('GET', path);
    if (res.status !== 200) return { status: res.status, error: res.error ?? `HTTP ${res.status}` };
    try {
      return { status: 200, json: JSON.parse(res.text) };
    } catch {
      return { status: 200, error: 'response is not JSON' };
    }
  }

  return { request, getJson };
}

/**
 * Serve the guarded client on an ephemeral loopback port, for the CLI to use as
 * its shell URL. Refused requests get a 403 and never reach the target.
 */
export async function startGuardProxy(client) {
  const refused = [];
  let forwarded = 0;

  const server = createServer(async (req, res) => {
    req.resume();
    try {
      const upstream = await client.request(req.method, req.url);
      forwarded += 1;
      res.writeHead(upstream.status || 502, { 'content-type': 'application/json' });
      res.end(upstream.text);
    } catch (err) {
      if (!(err instanceof GuardViolation)) { res.writeHead(500).end(); return; }
      refused.push({ method: req.method, path: String(req.url).split('?')[0] });
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"error":"refused by smoke guard"}');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    refused,
    forwardedCount: () => forwarded,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}
