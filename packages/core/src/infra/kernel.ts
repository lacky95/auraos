/**
 * Boot step 0 (D94 IC-5, acceptance 4): the kernel applies the infrastructure config to its own
 * process before anything reaches the network, and again whenever the rendered config changes
 * (live reload, D94 §5.5: no restart for a CA or proxy change).
 *
 * os/boot.sh already exported the render's non-secret env (`generated/current/env.sh`) before
 * Node started, so Node read NODE_EXTRA_CA_CERTS and NODE_USE_ENV_PROXY at startup and every
 * child process inherits the proxy, NO_PROXY, CA and registry pointers. Step 0 then:
 *   - keeps the kernel's own internal traffic direct: with NODE_USE_ENV_PROXY, Node's http module
 *     and fetch would send a request to `aura-<instance>` (a Docker name no NO_PROXY can list)
 *     to the corporate proxy. `http(s).globalAgent` become plain agents (the gateway, the WS
 *     proxy and the lifecycle calls are all internal), and fetch goes through a router: internal
 *     destinations direct, everything else through the configured proxy;
 *   - sets the TLS default CA list (live: `tls.setDefaultCACertificates`);
 *   - mirrors a changed env into `process.env` for later child processes;
 *   - reports what it applied in `status.json.infra` (categories, never values).
 * No config: nothing happens (exactly today's behaviour, D94 acceptance 6).
 */
import { EventEmitter } from 'node:events';
import { readFileSync, watch, type FSWatcher } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';
import type { InfraBootStatus } from './types.js';
import { INFRA_GENERATED_DIR } from './types.js';
import { dataRootOf, readInfraManifest, renderDigest } from './propagate.js';

/** Env the kernel never mirrors into its own `process.env` live (Node reads them at startup only). */
const STARTUP_ONLY = new Set(['NODE_OPTIONS', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS']);
const DISPATCHER = Symbol.for('undici.globalDispatcher.1');

/** Node 22.19+ (the base image pins 22.23): the live default CA list. */
const tlsCa = tls as unknown as {
  setDefaultCACertificates?: (certs: string[]) => void;
  getCACertificates: (type?: 'default' | 'bundled' | 'system' | 'extra') => string[];
};
function setDefaultCas(certs: string[]): boolean {
  if (typeof tlsCa.setDefaultCACertificates !== 'function') return false;
  tlsCa.setDefaultCACertificates(certs);
  return true;
}

interface Dispatcher { dispatch(opts: { origin?: string | URL }, handler: unknown): boolean; close(): Promise<void>; destroy(err?: Error): Promise<void> }
type DispatcherClass = new (opts?: Record<string, unknown>) => Dispatcher;

/** A loopback, private or link-local address, a single-label name, an `aura-*` Docker name, or `*.localhost`. */
export function isInternalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.startsWith('aura-') || h.endsWith('.aura-net')) return true;
  const ip = isIP(h);
  if (ip === 4) {
    const [a, b] = h.split('.').map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (ip === 6) return h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  return !h.includes('.');
}

/** True when `host` matches a NO_PROXY list entry (exact, `.suffix`/`*.suffix`, or `*`). */
export function noProxyMatches(host: string, noProxy: string): boolean {
  const h = host.toLowerCase();
  return noProxy.split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean).some((e) => {
    if (e === '*') return true;
    const d = e.replace(/:\d+$/, '').replace(/^\*?\./, '');
    return h === d || h.endsWith(`.${d}`);
  });
}

interface KernelInfraState {
  dataDir: string;
  status: InfraBootStatus;
  envKeys: Set<string>;
  baseDispatcher: Dispatcher | null;
  proxyClass: DispatcherClass | null;
  watcher: FSWatcher | null;
  onChange: ((s: InfraBootStatus) => void) | null;
}

let state: KernelInfraState | null = null;

const emptyStatus = (): InfraBootStatus => ({
  configured: false, digest: null, state: 'none', corporateCas: 0, proxy: 'off', kernelProxy: false,
  restartRequired: false, issues: [], appliedAt: null,
});

function pemsOf(file: string): string[] {
  return readFileSync(file, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

class RoutingDispatcher extends EventEmitter implements Dispatcher {
  constructor(private readonly direct: Dispatcher, private readonly proxied: Dispatcher, private readonly noProxy: string) { super(); }
  private pick(origin: string | URL | undefined): Dispatcher {
    let host = '';
    try { host = new URL(String(origin)).hostname; } catch { return this.direct; }
    return isInternalHost(host) || noProxyMatches(host, this.noProxy) ? this.direct : this.proxied;
  }
  dispatch(opts: { origin?: string | URL }, handler: unknown): boolean { return this.pick(opts.origin).dispatch(opts, handler); }
  async close(): Promise<void> { await Promise.all([this.direct.close(), this.proxied.close()]); }
  async destroy(err?: Error): Promise<void> { await Promise.all([this.direct.destroy(err), this.proxied.destroy(err)]); }
}

/** Apply (or re-apply) the rendered config to this process. */
function apply(s: KernelInfraState): InfraBootStatus {
  const st = emptyStatus();
  const g = globalThis as Record<symbol, unknown>;
  let manifest;
  try {
    manifest = readInfraManifest(s.dataDir);
  } catch (err) {
    st.configured = true;
    st.digest = renderDigest(s.dataDir);
    st.state = 'failed';
    st.issues.push((err as Error).message);
    return st;
  }
  const env = manifest?.env ?? {};
  // process.env for later child processes (the startup-only ones were exported by os/boot.sh).
  for (const k of s.envKeys) if (!(k in env) && !STARTUP_ONLY.has(k)) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (!STARTUP_ONLY.has(k)) process.env[k] = v;
  s.envKeys = new Set(Object.keys(env));
  if (!manifest) {
    if (s.baseDispatcher) g[DISPATCHER] = s.baseDispatcher;
    if (s.status.corporateCas) setDefaultCas(tlsCa.getCACertificates('bundled'));
    return st;
  }
  st.configured = true;
  st.digest = manifest.digest;
  st.state = 'ok';
  st.appliedAt = new Date().toISOString();

  // Trust: the corporate CAs (with the bundled roots unless the config replaces them).
  const extra = env['NODE_EXTRA_CA_CERTS'];
  const replace = /--use-openssl-ca/.test(env['NODE_OPTIONS'] ?? '');
  if (extra) {
    try {
      const corp = pemsOf(extra.replace(/^\/etc\/aura\/infra\//, `${join(dataRootOf(s.dataDir), INFRA_GENERATED_DIR, manifest.digest.slice(7))}/`));
      st.corporateCas = corp.length;
      if (!setDefaultCas(replace ? corp : [...tlsCa.getCACertificates('bundled'), ...corp])) {
        st.state = 'degraded';
        st.issues.push('this Node has no live CA reload: a CA change needs `aura restart os`');
      }
    } catch (err) {
      st.state = 'degraded';
      st.issues.push(`the corporate CA bundle can't be read (${(err as Error).message})`);
    }
  } else if (s.status.corporateCas) {
    setDefaultCas(tlsCa.getCACertificates('bundled'));
  }

  // Proxy: internal traffic direct; the kernel's own outbound fetch through the proxy.
  const httpProxy = env['HTTP_PROXY'], httpsProxy = env['HTTPS_PROXY'];
  if (httpProxy || httpsProxy) {
    st.proxy = 'configured';
    http.globalAgent = new http.Agent({ keepAlive: true });
    https.globalAgent = new https.Agent({ keepAlive: true });
    s.baseDispatcher ??= (g[DISPATCHER] as Dispatcher | undefined) ?? null;
    const C = s.proxyClass ?? (s.baseDispatcher?.constructor?.name === 'EnvHttpProxyAgent' ? s.baseDispatcher.constructor as DispatcherClass : null);
    s.proxyClass = C;
    if (C) {
      const noProxy = env['NO_PROXY'] ?? '';
      const direct = new C({ httpProxy: '', httpsProxy: '', noProxy: '*' });
      const proxied = new C({ httpProxy: httpProxy ?? httpsProxy, httpsProxy: httpsProxy ?? httpProxy, noProxy });
      g[DISPATCHER] = new RoutingDispatcher(direct, proxied, noProxy);
      st.kernelProxy = true;
    } else {
      st.state = 'degraded';
      st.restartRequired = true;
      st.issues.push('the proxy was configured after the shell started: the kernel\'s own requests go direct until `aura restart os`');
    }
  } else if (s.baseDispatcher) {
    g[DISPATCHER] = s.baseDispatcher;
  }
  return st;
}

export interface LoadInfrastructureOptions {
  dataDir?: string;
  /** Re-apply when `generated/current` changes (the server; never in tests). */
  watch?: boolean;
  /** Called with each new status (bootSystem saves it to status.json). */
  onChange?: (s: InfraBootStatus) => void;
}

/** Boot step 0. Idempotent; returns `status.json.infra`. */
export function loadInfrastructure(opts: LoadInfrastructureOptions = {}): InfraBootStatus {
  const dataDir = dataRootOf(opts.dataDir);
  state ??= { dataDir, status: emptyStatus(), envKeys: new Set(), baseDispatcher: null, proxyClass: null, watcher: null, onChange: null };
  state.dataDir = dataDir;
  state.onChange = opts.onChange ?? state.onChange;
  // No config and nothing applied before: leave the process exactly as it is.
  if (renderDigest(dataDir) === null && !state.status.configured) {
    state.status = emptyStatus();
  } else {
    state.status = apply(state);
  }
  if (opts.watch && !state.watcher) watchRendered(state);
  return { ...state.status, issues: [...state.status.issues] };
}

/** Re-apply now (a config apply, the doctor). */
export function reloadInfrastructure(): InfraBootStatus {
  if (!state) return loadInfrastructure();
  state.status = apply(state);
  state.onChange?.(state.status);
  return { ...state.status, issues: [...state.status.issues] };
}

/** What step 0 applied (null before it ran in this module copy). */
export function infraBootStatus(): InfraBootStatus | null {
  return state ? { ...state.status, issues: [...state.status.issues] } : null;
}

function watchRendered(s: KernelInfraState): void {
  const dir = join(s.dataDir, INFRA_GENERATED_DIR);
  let last = renderDigest(s.dataDir);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    timer = null;
    const now = renderDigest(s.dataDir);
    if (now === last) return;
    last = now;
    reloadInfrastructure();
  };
  try {
    s.watcher = watch(dir, () => { timer ??= setTimeout(check, 200); timer.unref?.(); });
    s.watcher.unref?.();
    s.watcher.on('error', () => { s.watcher?.close(); s.watcher = null; });
  } catch {
    // No generated/ yet (no config): poll for the first one, cheaply.
    const t = setInterval(() => {
      if (renderDigest(s.dataDir) === null) return;
      clearInterval(t);
      check();
      watchRendered(s);
    }, 30_000);
    t.unref?.();
  }
}
