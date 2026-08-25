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
import { existsSync } from 'node:fs';
import { execFile, execFileSync, spawn } from 'node:child_process';

const DOCKER_SOCK = '/var/run/docker.sock';

/**
 * Where a sidecar volume lands by default, as a path inside the app-data
 * volume. Exported so a controller can resolve the location BEFORE it has a
 * `SidecarHost` — building the `services` array often needs the answer already
 * (e.g. to pass the runtime a host-resolvable path), and computing it a second
 * time by hand is how the two ends drift apart.
 */
export function defaultSidecarSubpath(appDataSubpath: string, service: string, volume: string): string {
  return `${appDataSubpath}/.sidecars/${service}/${volume}`;
}

/**
 * The app's own data dir as a path inside the app-data volume, discovered by
 * asking the daemon where our `/data` comes from: the OS mounts it as
 * `volume-subpath=<…>/apps/<appId>/<instanceId>`, so one segment up is the
 * app-level dir. Prefer the OS-exported `AURA_APP_DATA_SUBPATH`; this is the
 * fallback for a shell older than that env var. Needs the docker socket.
 */
export function discoverAppDataSubpath(instanceId: string): string | undefined {
  if (!existsSync(DOCKER_SOCK)) return undefined;
  try {
    const out = execFileSync('docker',
      ['inspect', '--format', '{{json .HostConfig.Mounts}}', `aura-${instanceId}`],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, encoding: 'utf-8' });
    const mounts = JSON.parse(out || '[]') as Array<{
      Target?: string; VolumeOptions?: { Subpath?: string };
    }>;
    const sub = mounts.find((m) => m.Target === '/data')?.VolumeOptions?.Subpath;
    if (!sub) return undefined;
    return sub.split('/').slice(0, -1).join('/') || undefined;
  } catch {
    return undefined;   // not inspectable — caller falls back to the legacy volume
  }
}

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
   *
   * With NEITHER `volume` nor `subpath` set, placement is resolved as:
   *   1. the legacy per-app volume `aura-<appId>-<name>`, IF it already exists
   *      — an app that has been running keeps its data where it wrote it;
   *   2. otherwise `<AURA_APP_DATA_SUBPATH>/.sidecars/<service>/<name>` on the
   *      shared app-data volume, i.e. INSIDE the app's own data dir.
   *
   * (2) is the default for anything new. One directory then holds everything
   * the app owns: `aura mount --data <appId>` reaches the sidecar's state,
   * backup/move/uninstall take it along, and no volume outlives the app
   * unnoticed. Falls back to (1)'s name when the OS didn't export
   * `AURA_APP_DATA_SUBPATH` (older shell) — guessing a subpath would mount an
   * empty dir and look like data loss.
   */
  volumes?: Array<{ name: string; target: string; volume?: string; subpath?: string }>;
  /**
   * Names of env vars to inherit from the controller's `process.env` at spawn
   * time and forward into the sibling. Missing names are skipped silently.
   *
   * The natural population source is AuraOS Context (Settings → Context) —
   * anything the user marks `inject: env` lands in the controller's env at
   * boot via `ContextStore.materializeAll()`, and this list is what carries
   * those values across the sibling-container boundary.
   *
   * Kept as an explicit allowlist rather than "forward everything" so a
   * foreign runtime image can't accidentally see unrelated secrets the user
   * set for other apps. List only what the runtime needs, e.g.
   *   `envInherit: ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']`.
   */
  envInherit?: string[];

  // ── Opt-in capability inheritance ──────────────────────────────────────
  // Siblings are ISOLATED by default: they get only their declared
  // env/volumes/network and none of the controller's OS identity, OS-API
  // reach, or kernel privileges. Each field below deliberately crosses one of
  // those isolation boundaries and is off unless set.

  /**
   * Inject the controller's AuraOS identity + OS-API base into the sibling so
   * it can call back into the OS (Context, KV, data providers) *as this app*.
   * Forwards whichever of these the controller actually has in its env:
   *   `APP_ID`          → `AURA_APP_ID`
   *   `APP_INSTANCE_ID` → `AURA_INSTANCE_ID`
   *   `OS_API_BASE`     → `AURA_OS_URL` (and kept as `OS_API_BASE`)
   *   `AURA_SHELL_HOSTNAME`
   * `OS_API_BASE` already points at the shell's aura-net hostname
   * (`http://aura-shell:3000`), so the sibling can reach it directly.
   * Default false — the sibling has no OS identity.
   */
  inheritIdentity?: boolean;

  /**
   * Linux kernel capabilities to grant the sibling (docker `--cap-add`),
   * e.g. `['NET_ADMIN']` for a VPN/tun runtime. Default none.
   */
  capabilities?: string[];

  /**
   * Host devices to pass through (docker `--device`), e.g. `['/dev/kvm']`,
   * `['/dev/net/tun']`. Default none.
   */
  devices?: string[];

  /**
   * Run the sibling privileged (docker `--privileged`). DANGEROUS — grants
   * full host-device access and is effectively host root. Prefer the narrower
   * `capabilities` / `devices`. Default false.
   */
  privileged?: boolean;

  /**
   * Forward the controlling app's declared AuraOS permissions (passed via
   * `SidecarOptions.permissions`, sourced from `manifest.permissions`) into
   * the sibling as `AURA_PERMISSIONS=<comma-joined>`. Lets the runtime — or a
   * future enforced OS policy — see what the app was granted.
   * NOTE: AuraOS permission enforcement is an MVP no-op today
   * (`PermissionManager` always allows), so this is primarily forward-looking
   * scaffolding. Default false.
   */
  inheritPermissions?: boolean;

  /**
   * Mount the AuraOS CLI toolchain into the sibling, exactly as the OS does
   * for native app containers (`ContainerRunner`):
   *   - `/aura/my-tools` ← `aura/runtime/<instanceId>/tools` subpath
   *     (read-only) — the per-instance ALLOWLIST the OS provisions from the
   *     controlling app's manifest `tools[]`. The sibling shares the
   *     controller's instance dir, so it inherits EXACTLY the granted set and
   *     nothing more — an ungranted binary is simply not present.
   *   - `/aura/all-tools` ← `aura/toolchain/bin` subpath (read-only), the full
   *     toolchain. Mounted ONLY when the OS is running in legacy symlink mode
   *     (`AURA_TOOLS_MODE=symlink`), where allowlist entries are symlinks that
   *     need that path to resolve against. In the default hardlink mode the
   *     allowlist entries are the binaries themselves, so this mount is
   *     omitted — mounting it would hand the sibling every installed tool by
   *     absolute path and bypass the controller's grant.
   * `/aura/my-tools` is prepended to the sibling's PATH (read from the image's
   *  own baked PATH so the foreign runtime's paths are preserved, not clobbered).
   *
   * Requires the shared app-data volume — `SidecarOptions.appDataVolume`
   * (default `aura_aura-app-data`). To expose a specific tool (e.g. `aura`) in
   * the sibling, add it to the controlling app's manifest `tools[]` so the OS
   * provisions it into `/aura/my-tools`. Default false (no toolchain).
   */
  inheritTools?: boolean;

  /**
   * Share the controlling app's cross-app mount root (`aura mount`) with the
   * sibling at `/mnt/aura`.
   *
   * The sibling mounts the SAME per-instance subpath the app does
   * (`aura/mounts/<instanceId>`), so it inherits exactly what the controller
   * has mounted and nothing more — the same containment model as
   * `inheritTools`. Each mounted app keeps the ro/rw mode it was mounted with;
   * this flag grants visibility, not additional write access.
   *
   * **Inheritance is LIVE.** Docker leaves `--mount type=volume` mounts as
   * slaves of the host peer group, so a host-side bind made by `aura mount`
   * after the sibling started still propagates into it — mounting and
   * unmounting are visible in the sibling without recreating it. That falls
   * out of the propagation design; no polling or re-exec is involved.
   *
   * Requires the app container to be using the CANONICAL `/mnt/aura` root.
   * Containers spawned before that existed fall back to `/data/.mnt` inside
   * their own data dir, which a sibling does not mount — so the sibling would
   * see an empty root until the controlling app is restarted.
   *
   * Default false.
   */
  inheritMounts?: boolean;

  /**
   * Bind the host docker socket into the sibling.
   *
   * ⚠️ This is NOT a slice of the controller's privileges the way the other
   * `inherit*` flags are. `inheritTools` hands over exactly the granted
   * binaries, `inheritMounts` exactly the mounted apps, `inheritPermissions`
   * exactly the declared strings. The docker socket is not scoped to the app
   * at all: anything holding it can start a privileged container, bind the
   * host filesystem and read every volume on the machine. Enabling this gives
   * a FOREIGN runtime image host root. Named `inheritDockerSocket` rather than
   * `inheritDocker` so a manifest can't ask for it by accident while reaching
   * for the `docker` CLI — which `inheritTools` already provides.
   *
   * Bounded by one thing: the controller can only pass on a socket it already
   * has. AuraOS binds `/var/run/docker.sock` into an app container only when
   * its manifest `tools[]` grants `docker` (ContainerRunner), so if the
   * controlling app wasn't granted it there is no socket here to forward and
   * this is skipped with a warning. A sibling therefore can never exceed its
   * controller — enforced by what's actually present, not by re-reading a
   * manifest the SDK doesn't have.
   *
   * Default false.
   */
  inheritDockerSocket?: boolean;

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
   * The shared AuraOS app-data docker volume (the compose-declared volume every
   * native app persists to). Only consumed when a service sets
   * `inheritTools: true`, to mount the toolchain subpaths. Default reads
   * `AURA_APP_DATA_VOLUME` from the env, falling back to `aura_aura-app-data`.
   */
  appDataVolume?: string;
  /**
   * This app's own data dir as a path INSIDE `appDataVolume` (e.g.
   * `scopes/users/default/apps/com.example.foo`). Exported by the OS as
   * `AURA_APP_DATA_SUBPATH`; it can't be derived in-container because the app
   * only ever sees its INSTANCE dir mounted at `/data`. Used as the base for
   * default sidecar volume placement — see `volumes`.
   */
  appDataSubpath?: string;
  /**
   * Host path to the AuraOS `/workspace` tree, bind-mounted read-only into a
   * sibling for `inheritTools` (the CLI wrappers `exec node
   * /workspace/packages/<tool>/dist/…`). Default reads `AURA_HOST_WORKSPACE`,
   * falling back to `/workspace`. On VM-based docker daemons (macOS) set this
   * to the host-visible path.
   */
  workspaceRoot?: string;
  /**
   * The AuraOS node_modules docker volume, mounted read-only at
   * `/workspace/node_modules` for `inheritTools` so the CLI tools resolve their
   * dependencies. Default reads `AURA_NODE_MODULES_VOLUME`, falling back to
   * `aura_aura-node-modules`.
   */
  nodeModulesVolume?: string;
  /**
   * The controlling app's declared AuraOS permissions (`manifest.permissions`).
   * Only consumed when a service sets `inheritPermissions: true`, where it's
   * forwarded into the sibling as `AURA_PERMISSIONS`. Pass the manifest array
   * so the OS grant list can cross the sibling-container boundary.
   */
  permissions?: string[];
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
  readonly opts: Required<Pick<SidecarOptions, 'network' | 'volumePrefix' | 'helperImage' | 'appDataVolume' | 'workspaceRoot' | 'nodeModulesVolume'>> & SidecarOptions;
  phase: SidecarPhase = 'init';
  detail = '';
  private ensuring: Promise<void> | null = null;

  constructor(options: SidecarOptions) {
    this.opts = {
      network: process.env['AURA_DOCKER_NETWORK'] || 'aura-net',
      volumePrefix: `aura-${options.appId}`,
      helperImage: process.env['AURA_BASE_IMAGE'] || 'aura-base',
      appDataVolume: process.env['AURA_APP_DATA_VOLUME'] || 'aura_aura-app-data',
      appDataSubpath: process.env['AURA_APP_DATA_SUBPATH'] || undefined,
      workspaceRoot: process.env['AURA_HOST_WORKSPACE'] || '/workspace',
      nodeModulesVolume: process.env['AURA_NODE_MODULES_VOLUME'] || 'aura_aura-node-modules',
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

  /**
   * Where a declared volume actually lives — the single answer every code path
   * below asks for (mount args, seeding helpers, host-path export), so they
   * can't drift apart. Precedence and rationale: see `ServiceSpec.volumes`.
   */
  resolveVolume(
    serviceName: string,
    v: { name: string; volume?: string; subpath?: string },
  ): { source: string; subpath?: string } {
    // Explicit wins, and an explicit subpath without a volume keeps its
    // historic source (the derived name) rather than silently moving.
    if (v.volume || v.subpath) {
      const source = v.volume ?? this.volumeName(v.name);
      return v.subpath ? { source, subpath: v.subpath } : { source };
    }
    const legacy = this.volumeName(v.name);
    if (this.legacyVolumeExists(legacy)) return { source: legacy };
    const base = this.opts.appDataSubpath ?? this.discoverAppDataSubpath();
    if (!base) return { source: legacy };
    return { source: this.opts.appDataVolume, subpath: defaultSidecarSubpath(base, serviceName, v.name) };
  }

  private discoveredSubpath?: string | null;
  /**
   * Fallback for `appDataSubpath` when the OS didn't export it (a shell older
   * than the env var): ask the daemon where our OWN `/data` comes from. The OS
   * mounts it as `volume-subpath=<…>/apps/<appId>/<instanceId>`, so one segment
   * up is the app-level dir. Needs the docker socket — apps without it get the
   * env var or the legacy volume, never a guess.
   */
  private discoverAppDataSubpath(): string | undefined {
    if (this.discoveredSubpath !== undefined) return this.discoveredSubpath ?? undefined;
    const found = discoverAppDataSubpath(this.opts.instanceId);
    this.discoveredSubpath = found ?? null;
    if (found) this.log(`app data subpath discovered by self-inspect: ${found}`);
    return found;
  }

  private readonly legacyVolumes = new Map<string, boolean>();
  /** Does the pre-`.sidecars` derived volume exist? Cached: asked per spawn. */
  private legacyVolumeExists(source: string): boolean {
    const hit = this.legacyVolumes.get(source);
    if (hit !== undefined) return hit;
    let exists = true;
    try {
      execFileSync('docker', ['volume', 'inspect', source],
        { stdio: ['ignore', 'ignore', 'ignore'], timeout: 10_000 });
    } catch { exists = false; }
    this.legacyVolumes.set(source, exists);
    return exists;
  }

  /**
   * Create a subpath dir before anything mounts it. Docker ERRORS on a missing
   * `volume-subpath` (unlike a bind source, which it silently creates), and the
   * app can't mkdir it itself: only its INSTANCE dir is mounted, at `/data` —
   * the app-level dir one segment up isn't visible anywhere in the container.
   * Idempotent, so it runs on every spawn rather than needing a first-run flag.
   */
  private async ensureVolumeSubpath(source: string, subpath: string): Promise<void> {
    await execDocker(['run', '--rm', '-v', `${source}:/vol`, this.opts.helperImage,
      'mkdir', '-p', `/vol/${subpath}`]);
  }
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
   * The image's own baked `PATH` (from its `Config.Env`), used to PREPEND the
   * toolchain dir for `inheritTools` without clobbering the foreign runtime's
   * paths. Falls back to a conventional PATH if the image declares none.
   */
  private async imagePath(image: string): Promise<string> {
    try {
      const out = await execDocker(['image', 'inspect', image, '--format', '{{range .Config.Env}}{{println .}}{{end}}']);
      const line = out.split('\n').find((l) => l.startsWith('PATH='));
      if (line) return line.slice('PATH='.length);
    } catch { /* fall through to default */ }
    return '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  }

  /**
   * `--mount`/`-e` args that mount the AuraOS CLI toolchain into a sibling for
   * `inheritTools`, mirroring `ContainerRunner`'s app-container provisioning:
   * the per-instance allowlist read-only at `/aura/my-tools`, `/aura/my-tools`
   * prepended to PATH, and — in legacy symlink mode only — the full toolchain
   * at `/aura/all-tools` so those symlinks resolve.
   *
   * The mode comes from `AURA_TOOLS_MODE`, which the OS sets on every app
   * container. Absent (an older shell, or a controller started outside the
   * OS), we assume legacy mode and mount the store: a sibling that can't find
   * its tools is a hard failure, whereas the extra mount only costs isolation
   * on a deployment that wasn't enforcing it anyway.
   */
  /**
   * `--mount` args sharing the controller's cross-app mount root with a
   * sibling for `inheritMounts`.
   *
   * Same subpath as the app container gets from `ContainerRunner`, so the
   * sibling sees exactly the controller's mounts. Deliberately NOT `readonly`:
   * each mounted app is its own child mount carrying the ro/rw it was mounted
   * with, and marking the PARENT read-only would neither propagate down nor
   * prevent a writable child — it would just misrepresent what the sibling can
   * do. Access control lives on the individual mounts.
   */
  /**
   * `-v` arg forwarding the host docker socket for `inheritDockerSocket`.
   *
   * The gate is physical rather than declarative: we forward the socket only
   * if THIS container has one. AuraOS binds it only for apps whose `tools[]`
   * grants `docker`, so an ungranted controller simply has nothing to pass on
   * and we skip loudly instead of producing a sibling with a dead socket path.
   */
  private dockerSocketArgs(): string[] {
    if (!existsSync(DOCKER_SOCK)) {
      this.log(
        `inheritDockerSocket: no ${DOCKER_SOCK} in this app — its manifest tools[] does not grant 'docker', so there is nothing to forward. Skipping.`,
      );
      return [];
    }
    this.log(`inheritDockerSocket: forwarding ${DOCKER_SOCK} — the sibling gets HOST ROOT via the daemon.`);
    return ['-v', `${DOCKER_SOCK}:${DOCKER_SOCK}`];
  }

  private mountInheritArgs(): string[] {
    return [
      '--mount', `type=volume,source=${this.opts.appDataVolume},target=/mnt/aura,volume-subpath=aura/mounts/${this.opts.instanceId}`,
      '-e', 'AURA_MOUNT_ROOT=/mnt/aura',
    ];
  }

  private async toolInheritArgs(image: string): Promise<string[]> {
    const vol = this.opts.appDataVolume;
    const basePath = await this.imagePath(image);
    const legacy = (process.env['AURA_TOOLS_MODE'] ?? 'symlink') === 'symlink';
    return [
      ...(legacy
        ? ['--mount', `type=volume,source=${vol},target=/aura/all-tools,volume-subpath=aura/toolchain/bin,readonly`]
        : []),
      '--mount', `type=volume,source=${vol},target=/aura/my-tools,volume-subpath=aura/runtime/${this.opts.instanceId}/tools,readonly`,
      // The CLI wrappers `exec node /workspace/packages/<tool>/dist/…`, so the
      // workspace source + its node_modules must be visible (read-only), exactly
      // as ContainerRunner binds them into native app containers.
      '-v', `${this.opts.workspaceRoot}/packages:/workspace/packages:ro`,
      '--mount', `type=volume,source=${this.opts.nodeModulesVolume},target=/workspace/node_modules,readonly`,
      '-e', `PATH=/aura/my-tools:${basePath}`,
      // The `-e PATH` above only covers processes that inherit the container's
      // env. A LOGIN shell doesn't: /etc/profile assigns PATH outright (both
      // its root and non-root branches), dropping /aura/my-tools, so anything
      // shelling out via `bash -l` — an in-container agent running tool
      // commands, say — finds no toolchain no matter which user it runs as.
      // /etc/profile sources /etc/profile.d/*.sh AFTER that assignment, so the
      // same drop-in ContainerRunner installs in app containers re-prepends the
      // dir and wins, for every user. Unlike ContainerRunner we do NOT also
      // bind it over /etc/bash.bashrc: a sibling is a foreign image that may
      // ship its own, and clobbering it would be a regression the OS has no
      // business causing.
      '-v', `${this.opts.workspaceRoot}/os/bashrc.aura.sh:/etc/profile.d/aura-prompt.sh:ro`,
    ];
  }

  /**
   * Run a throwaway helper container mounting a volume — used for seeding.
   * Honors `volume` / `subpath` overrides so the seed lands where the runtime
   * actually reads, not on the auto-derived legacy volume name.
   */
  private helperRun(loc: { source: string; subpath?: string }): HelperRun {
    const { source } = loc;
    // `-v` doesn't support volume-subpath; use `--mount` when a subpath is set.
    const mountArgs = loc.subpath
      ? ['--mount', `type=volume,source=${source},target=/vol,volume-subpath=${loc.subpath}`]
      : ['-v', `${source}:/vol`];
    return (args: string[], stdin?: Buffer | string) => new Promise<void>((resolve, reject) => {
      const p = spawn('docker', ['run', '--rm', '-i', ...mountArgs, this.opts.helperImage, ...args],
        { stdio: [stdin !== undefined ? 'pipe' : 'ignore', 'inherit', 'inherit'] });
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`helper exited ${code}`))));
      if (stdin !== undefined) { p.stdin!.end(stdin); }
    });
  }

  /**
   * `-e AURA_VOLUME_HOST_<NAME>` for every declared volume, holding the path as
   * the DOCKER DAEMON sees it.
   *
   * Why this exists: a sibling that drives the docker socket (see
   * `inheritDockerSocket`) and wants to bind part of its own data into a
   * container it spawns CANNOT use its own paths. `-v /opt/data/x:/y` is
   * resolved by the daemon against the HOST, where `/opt/data` doesn't exist —
   * and docker doesn't error on a missing bind source, it silently creates an
   * empty dir. So the mount appears to work and is simply empty.
   *
   * The sibling can't look this up itself either: at spawn time it doesn't
   * exist yet, so there's nothing to `docker inspect`. The controller is the
   * only side that knows, because it DECLARED the volume — so we resolve it
   * here and hand the answer over as env.
   *
   * `<NAME>` is the volume's `name` upper-cased with non-alphanumerics turned
   * into underscores: `{ name: 'data' }` → `AURA_VOLUME_HOST_DATA`.
   *
   * Requires the controller to have the docker socket (its `tools[]` grants
   * `docker`). Without it, or before the volume exists, resolution is skipped
   * with a warning rather than exporting a path that would silently misbind.
   */
  private volumeHostArgs(svc: ServiceSpec): string[] {
    const vols = svc.volumes ?? [];
    if (vols.length === 0) return [];
    // Only meaningful for a sibling that can reach the daemon: a host path is
    // unusable — and misleading — without a socket to spend it on. Scoping it
    // to `inheritDockerSocket` keeps the env of every ordinary sidecar clean
    // and avoids a `docker volume inspect` per volume on every spawn.
    if (!svc.inheritDockerSocket) return [];
    if (!existsSync(DOCKER_SOCK)) return [];   // controller has no daemon access

    const out: string[] = [];
    for (const v of vols) {
      const loc = this.resolveVolume(svc.name, v);
      const source = loc.source;
      const key = v.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      let mountpoint = '';
      try {
        mountpoint = execFileSync('docker', ['volume', 'inspect', '-f', '{{.Mountpoint}}', source], {
          stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, encoding: 'utf-8',
        }).trim();
      } catch {
        // Volume not created yet (first run, pre-seed). Starting without the
        // hint beats starting with a wrong one: docker does NOT error on a
        // missing bind source, it silently creates an empty dir, so a bad path
        // fails quietly and looks like it worked.
        this.log(`volume host path: could not inspect '${source}' yet; AURA_VOLUME_HOST_${key} omitted`);
        continue;
      }
      if (!mountpoint) continue;
      const hostPath = loc.subpath ? `${mountpoint}/${loc.subpath}` : mountpoint;
      out.push('-e', `AURA_VOLUME_HOST_${key}=${hostPath}`);

      // PATH PARITY — mount the same data a SECOND time at its host-identical
      // path, so one string means the same thing in both namespaces.
      //
      // Without this, a sibling that computes a path from its own filesystem
      // (`$DATA/skills`) and hands it to the daemon is describing somewhere the
      // host has never heard of. Docker then creates an empty dir rather than
      // erroring, so the mount looks fine and is silently empty — the failure
      // mode this whole mechanism exists to prevent.
      //
      // With parity, the sibling can point its own config at `hostPath` and
      // both its `mkdir` and the daemon's bind resolve to the same bytes. It's
      // the same trick the OS uses for `/workspace` (host `/workspace` →
      // container `/workspace`).
      //
      // Skipped when the declared target already IS the host path — that's an
      // app that opted into parity by hand, and re-mounting would be a
      // duplicate-destination error.
      if (v.target !== hostPath) {
        out.push('--mount', `type=volume,source=${source},target=${hostPath}${loc.subpath ? `,volume-subpath=${loc.subpath}` : ''}`);
      }
    }
    return out;
  }

  /**
   * `-e` args forwarding the controller's AuraOS identity + OS-API base into a
   * sibling (for `inheritIdentity`). Only vars actually present in the
   * controller env are forwarded, so a sibling never gets an empty/misleading
   * value. `APP_ID`/`APP_INSTANCE_ID` fall back to the configured ids.
   */
  private identityInheritArgs(): string[] {
    const out: string[] = [];
    const push = (name: string, value: string | undefined) => {
      if (value !== undefined && value !== '') out.push('-e', `${name}=${value}`);
    };
    push('AURA_APP_ID',      process.env['APP_ID'] ?? this.opts.appId);
    push('AURA_INSTANCE_ID', process.env['APP_INSTANCE_ID'] ?? this.opts.instanceId);
    push('AURA_OS_URL',      process.env['OS_API_BASE']);
    push('OS_API_BASE',      process.env['OS_API_BASE']);
    push('AURA_SHELL_HOSTNAME', process.env['AURA_SHELL_HOSTNAME']);
    return out;
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

    // A volume-subpath mount needs its dir to exist BEFORE anything mounts it
    // (docker errors instead of creating it), and seeding below mounts it too.
    for (const v of svc.volumes ?? []) {
      const loc = this.resolveVolume(svc.name, v);
      if (loc.subpath) await this.ensureVolumeSubpath(loc.source, loc.subpath);
    }

    // First-run seeding into each named volume.
    if (this.opts.onSeed) {
      this.setPhase('seeding');
      for (const v of svc.volumes ?? []) {
        const loc = this.resolveVolume(svc.name, v);
        await this.opts.onSeed({ service: svc, volumeName: loc.source, run: this.helperRun(loc) });
      }
    }

    this.setPhase('starting', svc.name);
    await this.remove(svc.name);                 // clear exited/zombie so `run --name` won't 409
    // Toolchain mounts are computed async (image PATH lookup) before the arg
    // list so the rest stays a flat literal.
    const toolArgs = svc.inheritTools ? await this.toolInheritArgs(svc.image) : [];
    const mountArgs = svc.inheritMounts ? this.mountInheritArgs() : [];
    const sockArgs  = svc.inheritDockerSocket ? this.dockerSocketArgs() : [];
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
        const loc = this.resolveVolume(svc.name, v);
        const subpath = loc.subpath ? `,volume-subpath=${loc.subpath}` : '';
        return ['--mount', `type=volume,source=${loc.source},target=${v.target}${subpath}`];
      }),
      // The shared app-data volume's NAME. Always exported: a sibling that
      // drives the docker socket needs it to spawn containers with
      // `--mount type=volume,source=$AURA_APP_DATA_VOLUME,volume-subpath=…`,
      // which lets the daemon resolve the volume itself instead of naming a
      // host path. Together with AURA_INSTANCE_ID this makes a sidecar's own
      // spawn config portable across apps rather than hardcoding ids.
      '-e', `AURA_APP_DATA_VOLUME=${this.opts.appDataVolume}`,
      // The other two coordinates a spawned container needs to make the
      // toolchain actually usable. Real binaries work from `/aura/my-tools`
      // alone, but wrapper-script tools (`aura` is `exec node
      // /workspace/packages/aura-cli/dist/aura.cjs`) also need the workspace
      // source and its node_modules — otherwise the tool is present, on PATH,
      // and fails on every call.
      '-e', `AURA_NODE_MODULES_VOLUME=${this.opts.nodeModulesVolume}`,
      '-e', `AURA_HOST_WORKSPACE=${this.opts.workspaceRoot}`,
      // Host paths of the declared volumes, resolved by the controller because
      // the sibling can't look them up before it exists. Emitted BEFORE
      // `svc.env` so an explicit manifest value still wins on collision.
      ...this.volumeHostArgs(svc),
      ...Object.entries(svc.env ?? {}).flatMap(([k, val]) => ['-e', `${k}=${val}`]),
      // Inherit named vars from the controller's process.env (populated by
      // AuraOS Context on boot). Missing names are skipped so the manifest
      // can list every plausible key without breaking when the user hasn't
      // set them yet. Explicit `svc.env` entries above win on collision.
      ...(svc.envInherit ?? []).flatMap((name) => {
        const v = process.env[name];
        if (v === undefined) return [];
        if (svc.env && Object.prototype.hasOwnProperty.call(svc.env, name)) return [];
        return ['-e', `${name}=${v}`];
      }),
      // ── Opt-in capability inheritance (isolated by default) ──────────────
      // Identity/OS-API reach: sibling can call the OS as this app.
      ...(svc.inheritIdentity ? this.identityInheritArgs() : []),
      // Kernel-level grants.
      ...(svc.capabilities ?? []).flatMap((c) => ['--cap-add', c]),
      ...(svc.devices ?? []).flatMap((d) => ['--device', d]),
      ...(svc.privileged ? ['--privileged'] : []),
      // AuraOS permission grant list (forward-looking; enforcement is v2).
      ...(svc.inheritPermissions && this.opts.permissions?.length
        ? ['-e', `AURA_PERMISSIONS=${this.opts.permissions.join(',')}`]
        : []),
      // AuraOS CLI toolchain (allowlist mounts + PATH). `-e PATH` here lands
      // after svc.env/envInherit so docker's last-wins keeps our prepend.
      ...toolArgs,
      ...mountArgs,
      ...sockArgs,
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
