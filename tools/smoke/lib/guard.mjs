/**
 * The safety boundary of the live smoke test.
 *
 * Every request the tool makes, including those from the `aura` CLI (through
 * the loopback proxy in http.mjs), passes `guard.check()` BEFORE it is sent.
 * Anything not listed here is refused. Being a GET is not enough: on AuraOS
 * some GETs cold-start apps, rewrite job files or start containers.
 *
 * Paths are compared as raw strings, query included. Nothing is normalized, so
 * an encoded or dotted variant of an allowed path is simply not allowed.
 */

export const TERMINAL_APP_ID = 'com.aura.terminal';

/**
 * The complete list of requests the tool may send to a live shell.
 *
 * Template slots only accept ids discovered from `GET /api/apps`:
 *   {runningInstance}  a resumed, non-pool instance
 *   {runningTerminal}  the same, for the Terminal app, and never a bare app id.
 *                      The proxy cold-starts a stopped app when addressed by
 *                      app id on a path it provides, and the Terminal provides
 *                      /api/sessions. An exact instance id just gets a 503.
 */
export const ALLOWED_LIVE_REQUESTS = Object.freeze([
  { method: 'GET', path: '/api/os/about' },
  { method: 'GET', path: '/api/apps' },
  { method: 'GET', path: `/api/apps/${TERMINAL_APP_ID}/instances` },
  { method: 'GET', path: '/api/interfaces?consumers=0' },
  { method: 'GET', path: '/api/flights' },
  { method: 'GET', path: '/api/instances/io.lakner.terminalx/status' },
  { method: 'GET', path: '/api/nexus/installed' },
  { method: 'GET', path: '/api/notifications' },
  { method: 'GET', path: '/api/hosts' },
  { method: 'GET', template: '/api/proxy/{runningTerminal}/api/sessions' },
  { method: 'GET', template: '/api/instances/{runningInstance}/sidecars?usage=0' },
  { method: 'GET', template: '/api/instances/{runningInstance}/mounts' },
  { method: 'GET', template: '/api/instances/{runningInstance}/ports' },
].map(Object.freeze));

/**
 * Known-dangerous paths. The allowlist already blocks them. This list exists so
 * that a future allowlist edit cannot let one through, and for clear refusals.
 */
export const DENIED_LIVE_PATHS = Object.freeze([
  /^\/api\/admin(\/|$)/,                // self-update, cap-doctor, management
  /^\/api\/nexus(\/(?!installed$)|$)/,  // catalog routes can load sources or write cache
  /\/ws(\/|$)/,                         // a Terminal WebSocket creates a session
  /\/api\/sessions\/./,                 // screen, input, open, launch, events
  /\/mcp(\/|$)/,                        // MCP is POST and stateful
  /\/events(\/|$)/,                     // SSE follow
]);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeInstanceId(id) {
  return typeof id === 'string' && SAFE_ID.test(id) && !id.includes('..');
}

function malformedReason(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return 'path must start with /';
  if (path.startsWith('//')) return 'protocol-relative path';
  // eslint-disable-next-line no-control-regex
  if (/[\\#%\s\x00-\x1f\x7f]/.test(path)) return 'path contains a forbidden character';
  if (path.includes('..')) return 'path contains ..';
  if (path.indexOf('?') !== path.lastIndexOf('?')) return 'path has more than one ?';
  return null;
}

export function createGuard() {
  const slots = { runningInstance: new Set(), runningTerminal: new Set() };

  const matchesTemplate = (template, path) => {
    const m = /^(.*)\{(\w+)\}(.*)$/.exec(template);
    if (!m) return false;
    const [, prefix, slot, suffix] = m;
    if (!path.startsWith(prefix) || !path.endsWith(suffix)) return false;
    if (path.length <= prefix.length + suffix.length) return false;
    return slots[slot].has(path.slice(prefix.length, path.length - suffix.length));
  };

  const check = (method, path) => {
    if (method !== 'GET') return { ok: false, reason: `method ${method} is not allowed` };
    const bad = malformedReason(path);
    if (bad) return { ok: false, reason: bad };
    const pathname = path.split('?')[0];
    if (DENIED_LIVE_PATHS.some((re) => re.test(pathname))) return { ok: false, reason: 'path is on the denylist' };
    const allowed = ALLOWED_LIVE_REQUESTS.some((e) => e.method === method
      && (e.path ? e.path === path : matchesTemplate(e.template, path)));
    return allowed ? { ok: true } : { ok: false, reason: 'path is not on the allowlist' };
  };

  return {
    check,

    /** Replace the discovered ids from a `GET /api/apps` payload. */
    admit(apps) {
      slots.runningInstance.clear();
      slots.runningTerminal.clear();
      if (!Array.isArray(apps)) return;
      const appIds = new Set(apps.map((a) => a?.manifest?.id));
      for (const app of apps) {
        for (const inst of Array.isArray(app?.instances) ? app.instances : []) {
          if (inst?.state !== 'resumed' || inst.inPool || !isSafeInstanceId(inst.instanceId)) continue;
          slots.runningInstance.add(inst.instanceId);
          if (inst.appId === TERMINAL_APP_ID && !appIds.has(inst.instanceId)) {
            slots.runningTerminal.add(inst.instanceId);
          }
        }
      }
    },

    runningTerminals: () => [...slots.runningTerminal],
    runningInstances: () => [...slots.runningInstance],
  };
}
