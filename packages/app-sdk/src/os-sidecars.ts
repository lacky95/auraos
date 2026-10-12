/**
 * OS-managed sidecars — the official way for an app to run a foreign image
 * next to itself. The OS does the `docker run`; the app needs no docker tool.
 *
 *   import { osSidecars } from '@aura/app-sdk/os-sidecars';
 *
 *   const sc = osSidecars();                       // ids + token from the env
 *   const box = await sc.spawn({ template: 'worker', suffix: jobId, env: { JOB: jobId } });
 *   await fetch(`http://${box.sidecar.host}:8080/run`);
 *   const r = await sc.exec(box.sidecar.name, ['sh', '-c', 'echo hi']);
 *   await sc.mounts(box.sidecar.name).add('com.example.docs');   // needs sidecars.mounts + apps.mount
 *   await sc.remove(box.sidecar.name);
 *
 * Every sidecar is a `services[]` TEMPLATE of the calling app (permission
 * `sidecars.spawn`); the request may only override name/suffix, env,
 * envInherit, command and mounts. See core's sidecar-spec.ts.
 *
 * Server-side only: the token lives in the app's env (`AURA_INSTANCE_TOKEN`)
 * and must never reach a browser. Uses `fetch` only — no child_process — and
 * works unchanged inside an OS sidecar spawned with `inheritIdentity` (it
 * then acts with that sidecar's own token, so its spawns are its children).
 */

export interface SidecarMountsRequest {
  own?: boolean;
  inherit?: boolean | { exclude?: string[]; mode?: 'ro' };
}

export interface OsSpawnRequest {
  template: string;
  name?: string;
  suffix?: string;
  image?: string;
  env?: Record<string, string>;
  envInherit?: string[];
  command?: string[];
  mounts?: SidecarMountsRequest;
  replace?: boolean;
  takeover?: boolean;
  wait?: { port?: boolean; timeoutMs?: number };
}

export interface OsSidecar {
  name: string;
  template: string;
  image: string;
  containerName: string;
  /** DNS name on aura-net — `http://${host}:${port}` from the app. */
  host: string;
  port?: number;
  state: string;
  createdAt: string;
  owner?: string;
  managedBy: 'os';
  mounts: { own: boolean; inherit: boolean; exclude: string[]; forceRo: boolean };
  specHash: string;
}

export interface OsExecOptions {
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface OsExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface OsSidecarMount {
  id: string;
  targetAppId: string;
  kind: 'source' | 'data';
  mode: 'ro' | 'rw';
  containerPath: string;
  origin: 'added' | 'restored' | 'adopted' | 'inherited';
  inheritedFrom?: string;
}

export interface OsSidecarsOptions {
  /** OS API base. Default `OS_API_BASE` → `AURA_OS_URL`. */
  base?: string;
  /** Instance to act for. Default `APP_INSTANCE_ID` → `AURA_INSTANCE_ID`. */
  instanceId?: string;
  /** Bearer. Default `AURA_INSTANCE_TOKEN`. */
  token?: string;
  /** Per-request timeout; spawns may pull an image. Default 15 min. */
  timeoutMs?: number;
  /** Override for tests. */
  fetch?: typeof fetch;
}

/** A failed OS call — `status` is the HTTP status (0 = no response). */
export class OsSidecarError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'OsSidecarError';
  }
}

export interface OsSidecarsClient {
  readonly instanceId: string;
  /** Start (or adopt, when the same spec already runs) a sidecar. */
  spawn(req: OsSpawnRequest): Promise<{ created: boolean; sidecar: OsSidecar }>;
  list(): Promise<OsSidecar[]>;
  /** null when no OS sidecar of that name exists. */
  get(name: string): Promise<OsSidecar | null>;
  /** Delete it — and every sidecar it spawned. */
  remove(name: string): Promise<void>;
  exec(name: string, cmd: string[], opts?: OsExecOptions): Promise<OsExecResult>;
  logs(name: string, opts?: { tail?: number; since?: string; timestamps?: boolean }): Promise<{ stdout: string; stderr: string }>;
  /** The sidecar's cross-app mounts (spawned with `mounts.own` to add any). */
  mounts(name: string): {
    list(): Promise<OsSidecarMount[]>;
    add(targetAppId: string, opts?: { mode?: 'ro' | 'rw'; data?: boolean }): Promise<OsSidecarMount>;
    remove(mountId: string): Promise<void>;
  };
}

export function osSidecars(options: OsSidecarsOptions = {}): OsSidecarsClient {
  const env = typeof process !== 'undefined' ? process.env : {};
  const base = (options.base ?? env['OS_API_BASE'] ?? env['AURA_OS_URL'] ?? '').replace(/\/+$/, '');
  const instanceId = options.instanceId ?? env['APP_INSTANCE_ID'] ?? env['AURA_INSTANCE_ID'] ?? '';
  const token = options.token ?? env['AURA_INSTANCE_TOKEN'] ?? '';
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const doFetch = options.fetch ?? fetch;
  if (!base) throw new OsSidecarError(0, 'osSidecars: no OS API base (OS_API_BASE / AURA_OS_URL unset) — run inside an AuraOS app');
  if (!instanceId) throw new OsSidecarError(0, 'osSidecars: no instance id (APP_INSTANCE_ID / AURA_INSTANCE_ID unset)');

  const root = `${base}/api/instances/${encodeURIComponent(instanceId)}/sidecars`;
  const enc = encodeURIComponent;

  async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
    if (!token) throw new OsSidecarError(401, 'osSidecars: no AURA_INSTANCE_TOKEN in the env — the instance predates instance tokens; restart it');
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new OsSidecarError(0, `osSidecars: ${method} ${url} failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    let data: unknown = undefined;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
    if (!res.ok) {
      const msg = (data as { error?: string } | undefined)?.error ?? (typeof data === 'string' ? data : res.statusText);
      throw new OsSidecarError(res.status, msg);
    }
    return data as T;
  }

  return {
    instanceId,
    async spawn(req) {
      const r = await call<{ created: boolean; sidecar: OsSidecar }>('POST', root, req);
      return { created: r.created, sidecar: r.sidecar };
    },
    async list() {
      return (await call<{ sidecars: OsSidecar[] }>('GET', `${root}?view=managed`)).sidecars;
    },
    async get(name) {
      try { return (await call<{ sidecar: OsSidecar }>('GET', `${root}/${enc(name)}`)).sidecar; }
      catch (err) { if (err instanceof OsSidecarError && err.status === 404) return null; throw err; }
    },
    async remove(name) {
      await call('DELETE', `${root}/${enc(name)}`);
    },
    async exec(name, cmd, opts = {}) {
      return call<OsExecResult>('POST', `${root}/${enc(name)}/exec`, { cmd, ...opts });
    },
    async logs(name, opts = {}) {
      const q = new URLSearchParams();
      if (opts.tail !== undefined) q.set('tail', String(opts.tail));
      if (opts.since) q.set('since', opts.since);
      if (opts.timestamps) q.set('timestamps', '1');
      const qs = q.toString();
      return call<{ stdout: string; stderr: string }>('GET', `${root}/${enc(name)}/logs${qs ? `?${qs}` : ''}`);
    },
    mounts(name) {
      const m = `${root}/${enc(name)}/mounts`;
      return {
        async list() { return (await call<{ mounts: OsSidecarMount[] }>('GET', m)).mounts; },
        async add(targetAppId, opts = {}) {
          return (await call<{ mount: OsSidecarMount }>('POST', m, { targetAppId, ...opts })).mount;
        },
        async remove(mountId) { await call('DELETE', `${m}/${enc(mountId)}`); },
      };
    },
  };
}
