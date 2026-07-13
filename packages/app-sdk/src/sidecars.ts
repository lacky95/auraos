/**
 * `@aura/app-sdk/sidecars` — run foreign Docker images as sibling containers.
 *
 * AuraOS can't make an app container BE a foreign image (every app runs the
 * shared `aura-base` image). The established pattern is a thin controller that
 * bind-mounts the host docker socket (`tools: ["docker"]`) and `docker run`s
 * the foreign image as a SIBLING on `aura-net`, then reverse-proxies it —
 * com.aura.whisper and com.aura.registry both hand-roll this. This module
 * extracts that boilerplate so a "bring-your-own-runtime" app declares its
 * runtime in the manifest `services` block and wires it up in ~a dozen lines.
 *
 * What it owns:
 *   • idempotent `docker run` (force-remove-then-run), naming, aura-net,
 *     `--dns`, named volumes, restart policy, `aura.parent` label (so the OS
 *     can reap the siblings — see AppManager);
 *   • the AuraOS lifecycle contract on `$APP_PORT` (health answers immediately,
 *     siblings boot in the background, teardown on onDestroy);
 *   • a streaming reverse proxy (HTTP + WebSocket upgrade) for the service
 *     marked `proxyDashboard`, with pluggable auth + a "starting…" interstitial.
 *
 * Dependency-free (node built-ins only) so it runs unchanged in an Astro app,
 * a raw Node app, or anything else. Server-side only.
 */

import http from 'node:http';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';

/** One sibling runtime image — mirrors the manifest `services[]` entry. */
export interface ServiceSpec {
  name: string;
  image: string;
  /** Command/args appended after the image (sets the container CMD). */
  command?: string[];
  prePull?: boolean;
  port?: number;
  proxyDashboard?: boolean;
  env?: Record<string, string>;
  /**
   * Sibling-runtime bind points.
   *   - `name`   — logical id; becomes part of the derived docker volume name
   *                (`${volumePrefix}-${name}`) unless `volume` overrides it.
   *   - `target` — path inside the runtime container.
   *   - `volume` (optional) — override the derived name with an externally
   *                managed docker volume (e.g. AuraOS's shared
   *                `aura_aura-app-data`). Bypasses `volumePrefix`.
   *   - `subpath` (optional) — mount only a subpath of the source volume
   *                (docker's `--mount volume-subpath=…`). Lets sidecars park
   *                their state under `/data/aura/runtime/<appId>/…` on the
   *                shared OS volume without needing their own top-level bind.
   */
  volumes?: Array<{ name: string; target: string; volume?: string; subpath?: string }>;
  dns?: string[];
  restart?: 'no' | 'on-failure' | 'always' | 'unless-stopped';
  readiness?: { path?: string; timeoutMs?: number };
}

/** Auth hook for the proxied dashboard (e.g. cookie/session injection). */
export interface SidecarAuth {
  /** Headers to inject on every proxied request (HTTP + WS). May be async. */
  headers(): Record<string, string> | Promise<Record<string, string>>;
  /** True when an upstream response means "not authenticated". */
  isAuthBounce?(statusCode: number, location: string): boolean;
  /** Re-establish auth (called once, then the GET request is retried). */
  reauth?(): Promise<void>;
}

export interface SidecarOptions {
  appId: string;
  instanceId: string;
  /** Port the controller listens on ($APP_PORT). */
  appPort: number;
  services: ServiceSpec[];
  network?: string;          // default 'aura-net'
  /** Named-volume prefix; volume = `<prefix>-<vol.name>`. Default `aura-<appId>`. */
  volumePrefix?: string;
  /**
   * Value sent as `X-Forwarded-Prefix` on proxied requests so a subpath-aware
   * upstream (Starlette/FastAPI root_path, many SPA dashboards) emits correctly
   * prefixed URLs instead of root-absolute ones that escape the iframe proxy.
   * Defaults to the AuraOS shell proxy path `/api/proxy/<instanceId>` (no
   * trailing slash). Set '' to disable.
   */
  forwardedPrefix?: string;
  /** Base image used for throwaway helper containers (seeding). Default 'aura-base'. */
  helperImage?: string;
  auth?: SidecarAuth;
  /** Called once per service volume before first start — seed defaults here. */
  onSeed?(ctx: { service: ServiceSpec; volumeName: string; run: HelperRun }): Promise<void> | void;
  /** Structured log sink; defaults to console. */
  log?(msg: string): void;
}

/** Run a throwaway helper container (for seeding files into a volume, etc.). */
export type HelperRun = (args: string[], stdin?: Buffer | string) => Promise<void>;

export type SidecarPhase =
  | 'init' | 'pulling' | 'seeding' | 'starting' | 'ready' | 'image-missing' | 'error';

function execDocker(args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { (err as Error & { stderr?: string }).stderr = String(stderr); reject(err); }
      else resolve(String(stdout).trim());
    });
  });
}

export class SidecarHost {
  readonly opts: Required<Pick<SidecarOptions, 'network' | 'volumePrefix' | 'helperImage'>> & SidecarOptions;
  phase: SidecarPhase = 'init';
  detail = '';
  private ensuring: Promise<void> | null = null;

  constructor(options: SidecarOptions) {
    this.opts = {
      network: process.env['AURA_DOCKER_NETWORK'] || 'aura-net',
      volumePrefix: `aura-${options.appId}`,
      helperImage: process.env['AURA_BASE_IMAGE'] || 'aura-base',
      ...options,
    };
    // Default the reverse-proxy prefix to the AuraOS shell proxy path so a
    // subpath-aware dashboard emits prefixed URLs. `?? ` (not `||`) so callers
    // can pass '' to opt out.
    this.forwardedPrefix = options.forwardedPrefix ?? `/api/proxy/${options.instanceId}`;
  }
  private readonly forwardedPrefix: string;

  private log(msg: string): void { (this.opts.log ?? ((m: string) => console.log(m)))(`[sidecars] ${msg}`); }
  private setPhase(p: SidecarPhase, detail = ''): void { this.phase = p; this.detail = detail; this.log(`→ ${p}${detail ? ` (${detail})` : ''}`); }

  containerName(name: string): string { return `aura-${this.opts.instanceId}--${name}`; }
  volumeName(name: string): string { return `${this.opts.volumePrefix}-${name}`; }
  dashboard(): ServiceSpec | undefined { return this.opts.services.find((s) => s.proxyDashboard); }

  async isRunning(name: string): Promise<boolean> {
    const cn = this.containerName(name);
    try {
      const out = await execDocker(['ps', '--filter', `name=^${cn}$`, '--format', '{{.Names}}']);
      return out.split('\n').includes(cn);
    } catch { return false; }
  }
  private async remove(name: string): Promise<void> {
    try { await execDocker(['rm', '-f', this.containerName(name)]); } catch { /* already gone */ }
  }
  private async imageExists(image: string): Promise<boolean> {
    try { await execDocker(['image', 'inspect', image]); return true; } catch { return false; }
  }

  /**
   * Run a throwaway helper container mounting a volume — used for seeding.
   * Honors `volume` / `subpath` overrides so the seed lands where the runtime
   * actually reads, not on the auto-derived legacy volume name.
   */
  private helperRun(v: { name: string; volume?: string; subpath?: string }): HelperRun {
    const source = v.volume ?? this.volumeName(v.name);
    // `-v` doesn't support volume-subpath; use `--mount` when a subpath is set.
    const mountArgs = v.subpath
      ? ['--mount', `type=volume,source=${source},target=/vol,volume-subpath=${v.subpath}`]
      : ['-v', `${source}:/vol`];
    return (args: string[], stdin?: Buffer | string) => new Promise<void>((resolve, reject) => {
      const p = spawn('docker', ['run', '--rm', '-i', ...mountArgs, this.opts.helperImage, ...args],
        { stdio: [stdin !== undefined ? 'pipe' : 'ignore', 'inherit', 'inherit'] });
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`helper exited ${code}`))));
      if (stdin !== undefined) { p.stdin!.end(stdin); }
    });
  }

  /** Ensure every declared service is running (idempotent). */
  ensureAll(): Promise<void> {
    if (this.ensuring) return this.ensuring;
    this.ensuring = (async () => {
      for (const svc of this.opts.services) await this.ensure(svc);
    })()
      .catch((e: unknown) => { this.setPhase('error', (e as Error)?.message ?? String(e)); })
      .finally(() => { this.ensuring = null; });
    return this.ensuring;
  }

  private async ensure(svc: ServiceSpec): Promise<void> {
    if (await this.isRunning(svc.name)) { this.setPhase('ready', `${svc.name} already running`); return; }

    if (!(await this.imageExists(svc.image))) {
      this.setPhase('pulling', svc.image);
      try {
        await execDocker(['pull', svc.image], 20 * 60_000);
      } catch (e) {
        this.setPhase('image-missing', String((e as Error & { stderr?: string })?.stderr ?? (e as Error)?.message ?? '').split('\n').pop() ?? '');
        return; // health stays green; interstitial explains
      }
    }

    // First-run seeding into each named volume.
    if (this.opts.onSeed) {
      this.setPhase('seeding');
      for (const v of svc.volumes ?? []) {
        const volumeName = v.volume ?? this.volumeName(v.name);
        await this.opts.onSeed({ service: svc, volumeName, run: this.helperRun(v) });
      }
    }

    this.setPhase('starting', svc.name);
    await this.remove(svc.name);                 // clear exited/zombie so `run --name` won't 409
    const args = [
      'run', '-d',
      '--name', this.containerName(svc.name),
      '--network', this.opts.network,
      '--restart', svc.restart ?? 'unless-stopped',
      '--label', `aura.parent=${this.opts.instanceId}`,
      '--label', `aura.app=${this.opts.appId}`,
      '--label', `aura.service=${svc.name}`,
      ...(svc.dns ?? []).flatMap((d) => ['--dns', d]),
      ...(svc.volumes ?? []).flatMap((v) => {
        const source  = v.volume ?? this.volumeName(v.name);
        const subpath = v.subpath ? `,volume-subpath=${v.subpath}` : '';
        return ['--mount', `type=volume,source=${source},target=${v.target}${subpath}`];
      }),
      ...Object.entries(svc.env ?? {}).flatMap(([k, val]) => ['-e', `${k}=${val}`]),
      svc.image,
      ...(svc.command ?? []),
    ];
    await execDocker(args, 5 * 60_000);
    this.setPhase('starting', `${svc.name} up`);
    this.log(`${this.containerName(svc.name)} started (image=${svc.image})`);
  }

  /** Remove every sibling this app spawned. Call on onDestroy. */
  async teardownAll(): Promise<void> {
    await Promise.allSettled(this.opts.services.map((s) => this.remove(s.name)));
    this.log('siblings torn down');
  }

  // ── HTTP controller ────────────────────────────────────────────────────

  /**
   * Build (and optionally start) the controller HTTP server: serves the
   * AuraOS lifecycle contract + /api/status on $APP_PORT and reverse-proxies
   * the `proxyDashboard` service. Health answers immediately; siblings boot in
   * the background so a slow first-run image pull can't blow the OS's 60s
   * health window.
   */
  createServer(): http.Server {
    const dash = this.dashboard();
    const dashHost = dash ? this.containerName(dash.name) : null;
    const dashPort = dash?.port;

    const stamp = (res: http.ServerResponse) => {
      res.setHeader('X-Aura-App-Id', this.opts.appId);
      res.setHeader('X-Aura-Instance-Id', this.opts.instanceId);
    };
    const json = (res: http.ServerResponse, status: number, body: unknown) => {
      stamp(res); res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
    };

    const handleLifecycle = (req: http.IncomingMessage, res: http.ServerResponse, url: string): boolean => {
      if (req.method === 'GET' && url === '/api/lifecycle/health') {
        json(res, 200, { ok: true, appId: this.opts.appId, instanceId: this.opts.instanceId, runtime: this.phase });
        return true;
      }
      if (req.method === 'GET' && url === '/api/status') {
        json(res, 200, { appId: this.opts.appId, instanceId: this.opts.instanceId, runtime: this.phase, detail: this.detail, services: this.opts.services.map((s) => ({ name: s.name, image: s.image })) });
        return true;
      }
      if (req.method === 'POST' && url === '/api/lifecycle/onStart') { json(res, 200, { ok: true }); void this.ensureAll(); return true; }
      if (req.method === 'POST' && url === '/api/lifecycle/onDestroy') { json(res, 200, { ok: true }); this.teardownAll().catch(() => undefined); return true; }
      if (req.method === 'POST' && /^\/api\/lifecycle\/(onCreate|onResume|onPause|onStop)$/.test(url)) { json(res, 200, { ok: true }); return true; }
      return false;
    };

    const interstitial = (res: http.ServerResponse, status: number) => {
      stamp(res);
      const refresh = (this.phase === 'image-missing' || this.phase === 'error') ? '' : '<meta http-equiv="refresh" content="4">';
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><html><head><meta charset="utf-8">${refresh}<link rel="stylesheet" href="/api/os/theme.css">
<style>html,body{margin:0;height:100%;background:var(--aura-color-bg,#0a0a0a);color:var(--aura-color-text,#ccffcc);font-family:var(--aura-font-mono,monospace);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;text-align:center;padding:24px}h1{color:var(--aura-color-primary,#00ff41)}p{color:var(--aura-color-text-dim,#557755);max-width:520px}</style></head>
<body><h1>${this.opts.appId}</h1><p>Runtime status: <b>${this.phase}</b>${this.detail ? ` — ${this.detail}` : ''}</p></body></html>`);
    };

    const forward = async (req: http.IncomingMessage, res: http.ServerResponse, allowRetry: boolean): Promise<void> => {
      const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `${dashHost}:${dashPort}` };
      if (this.forwardedPrefix) headers['x-forwarded-prefix'] = this.forwardedPrefix;
      if (this.opts.auth) Object.assign(headers, await this.opts.auth.headers());
      const upstream = http.request({ hostname: dashHost!, port: dashPort!, method: req.method, path: req.url, headers }, (upRes) => {
        const loc = (upRes.headers.location as string) || '';
        if (allowRetry && this.opts.auth?.isAuthBounce?.(upRes.statusCode ?? 0, loc) && this.opts.auth.reauth) {
          upRes.resume();
          this.opts.auth.reauth().then(() => forward(req, res, false)).catch(() => interstitial(res, 502));
          return;
        }
        if ((upRes.statusCode ?? 500) < 400 && this.phase !== 'ready') this.setPhase('ready', 'dashboard serving');
        stamp(res);
        for (const [k, v] of Object.entries(upRes.headers)) if (v !== undefined) res.setHeader(k, v as string | string[]);
        res.writeHead(upRes.statusCode || 502); upRes.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) interstitial(res, this.phase === 'ready' ? 502 : 503); else res.destroy(); });
      req.pipe(upstream);
    };

    const server = http.createServer((req, res) => {
      const url = req.url || '/';
      if (handleLifecycle(req, res, url)) return;
      if (!dashHost) { interstitial(res, 503); return; }
      forward(req, res, req.method === 'GET').catch(() => { if (!res.headersSent) interstitial(res, 503); });
    });

    // WebSocket upgrades → pipe raw to the dashboard, injecting the same auth.
    server.on('upgrade', (req, sock, head) => {
      if (!dashHost) { sock.destroy(); return; }
      void (async () => {
        const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `${dashHost}:${dashPort}` };
        if (this.forwardedPrefix) headers['x-forwarded-prefix'] = this.forwardedPrefix;
        if (this.opts.auth) Object.assign(headers, await this.opts.auth.headers());
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (const [k, v] of Object.entries(headers)) {
          if (Array.isArray(v)) v.forEach((vv) => lines.push(`${k}: ${vv}`));
          else if (v !== undefined) lines.push(`${k}: ${v}`);
        }
        const up = net.connect(dashPort!, dashHost, () => {
          up.write(lines.join('\r\n') + '\r\n\r\n');
          if (head?.length) up.write(head);
          up.pipe(sock); sock.pipe(up);
        });
        const bail = () => { try { sock.destroy(); } catch { /* noop */ } try { up.destroy(); } catch { /* noop */ } };
        up.on('error', bail); sock.on('error', bail);
      })();
    });

    return server;
  }

  /** Convenience: build the server, start it, and kick off the siblings. */
  listen(): http.Server {
    const server = this.createServer();
    server.listen(this.opts.appPort, '0.0.0.0', () => {
      this.log(`controller listening on :${this.opts.appPort}${this.dashboard() ? ` → ${this.containerName(this.dashboard()!.name)}:${this.dashboard()!.port}` : ''}`);
      void this.ensureAll();
    });
    return server;
  }
}

/** Factory sugar: `createSidecars({...}).listen()`. */
export function createSidecars(options: SidecarOptions): SidecarHost {
  return new SidecarHost(options);
}
