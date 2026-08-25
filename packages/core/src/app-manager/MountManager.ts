/**
 * Cross-app filesystem mounting — attach another app's directory into an
 * ALREADY-RUNNING app container, with no restart.
 *
 * ## How it works
 *
 * Docker cannot add a mount to a running container, so we go under it and use
 * Linux mount propagation. Every app container's `/data` is a
 * `--mount type=volume,volume-subpath=…` of the shared app-data volume, and
 * docker leaves those as SLAVE mounts (`master:N`) of the host's peer group.
 * A slave receives propagation. So a host-side `mount --bind` landing anywhere
 * under the instance's data dir appears inside the running container
 * immediately, at native speed, with no `nsenter` into the app and no FUSE.
 *
 * We mount at `<instanceDataDir>/.mnt/<targetAppId>`, which surfaces inside the
 * consumer as `/data/.mnt/<targetAppId>`.
 *
 * ## Read-only is NOT `remount,ro`
 *
 * Mount-attribute changes do not propagate to peers/slaves: `mount --bind`
 * followed by `mount -o remount,ro,bind` leaves the container seeing a WRITABLE
 * mount (measured — a probe write reached the target app's real source).
 * `mount --bind -o ro` also fails on util-linux 2.38 (classic API fallback).
 *
 * What works is binding from a source that is ALREADY read-only: the kernel
 * refuses to make a bind of a locked read-only mount more permissive, and the
 * `ro` attribute is therefore present at propagation time. So the helper mounts
 * the source with `:ro` and does a plain bind. Verified: container sees
 * `ro,relatime`, writes fail with `Read-only file system`.
 *
 * Because a silent ro→rw downgrade would hand out a filesystem boundary that
 * doesn't exist, every mount is VERIFIED after the fact against the target
 * container's own `/proc/self/mountinfo`, and rolled back if it doesn't match.
 */
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppRegistry } from './AppRegistry.js';
import type { ScopeRegistry } from '../scopes/ScopeRegistry.js';
import type { ContainerRunner } from './ContainerRunner.js';

const HELPER_IMAGE = process.env['AURA_BASE_IMAGE'] ?? 'aura-base';
/**
 * Canonical mount root inside a consumer container. Provisioned at spawn by
 * `ContainerRunner`, so only containers started since that change have it.
 */
export const MOUNT_ROOT_PATH = '/mnt/aura';
/**
 * Legacy root, relative to the consumer's own `/data`. Every container has a
 * `/data` volume mount regardless of age, and docker leaves it a slave of the
 * host peer group — so this works on containers spawned before `/mnt/aura`
 * existed. Kept permanently as the fallback rather than as a migration step.
 */
export const MOUNT_DIR_NAME = '.mnt';

export type MountMode = 'ro' | 'rw';
export type MountKind = 'source' | 'data';

/** Mirrors ContainerRunner.containerName — same sanitisation rule. */
function containerNameFor(instanceId: string): string {
  return `aura-${instanceId.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}

export interface AuraMount {
  /** `<targetAppId>` for a source mount, `<targetAppId>:data` for a data mount. */
  id: string;
  /** The CONSUMER — the instance the files are mounted INTO. */
  instanceId: string;
  targetAppId: string;
  kind: MountKind;
  mode: MountMode;
  /** Where it appears inside the consumer container. */
  containerPath: string;
  /** Daemon-visible source path that was bound. */
  hostSource: string;
  /** Daemon-visible destination path. */
  hostDest: string;
  createdAt: string;
}

export interface AddMountSpec {
  targetAppId: string;
  mode?: MountMode;
  /** Mount the target's DATA dir instead of its source. */
  data?: boolean;
}

interface MountManagerOpts {
  dataDir: string;
  registry: AppRegistry;
  scopeRegistry: ScopeRegistry;
  runner: ContainerRunner;
  /** Resolve a consumer instanceId → its shell-side data dir. */
  instanceDataDir(instanceId: string): string | null;
}

export class MountManager {
  /** instanceId → mountId → mount. Authoritative state is the kernel; this is a cache. */
  private mounts = new Map<string, Map<string, AuraMount>>();

  constructor(private readonly opts: MountManagerOpts) {}

  // ─── Declarations ──────────────────────────────────────────────────────
  //
  // The kernel is authoritative for what IS mounted, but it can't answer what
  // the user ASKED FOR: binds are reaped whenever an instance stops (a leaked
  // bind pins the source filesystem), and a container created afterwards does
  // NOT inherit binds that already exist under its mount root — docker's volume
  // mount is a non-recursive bind, so only containers that were running at
  // add-time receive propagation. Without a durable record, every mount
  // silently evaporated on the next restart while `aura mount ls` kept
  // reporting it.
  //
  // So the DECLARATION is persisted next to (not inside) the mount root, and
  // re-applied by `reapply()` once the container is up again.

  private declFile(instanceId: string): string {
    return join(this.opts.dataDir, 'aura', 'mounts', '.state', `${instanceId}.json`);
  }

  private readDecls(instanceId: string): AddMountSpec[] {
    try {
      const raw = JSON.parse(readFileSync(this.declFile(instanceId), 'utf-8')) as unknown;
      return Array.isArray(raw) ? raw as AddMountSpec[] : [];
    } catch { return []; }   // absent or corrupt — nothing declared
  }

  /** Persist the current mount set as declarations. Never throws: a failed
   *  write must not fail the mount the user just asked for. */
  private writeDecls(instanceId: string): void {
    const specs: AddMountSpec[] = this.list(instanceId).map((m) => ({
      targetAppId: m.targetAppId, mode: m.mode, data: m.kind === 'data',
    }));
    try {
      mkdirSync(dirname(this.declFile(instanceId)), { recursive: true });
      if (specs.length === 0) rmSync(this.declFile(instanceId), { force: true });
      else writeFileSync(this.declFile(instanceId), JSON.stringify(specs, null, 2));
    } catch (err) {
      console.warn(`[MountManager] could not persist mounts for ${instanceId}: ${(err as Error).message}`);
    }
  }

  /**
   * Re-create every declared mount for an instance whose container has just
   * started. Called by the AppManager after `onCreate`, so the app sees its
   * mounts as early as propagation allows.
   *
   * Best-effort per mount: one target that has since been uninstalled must not
   * stop the rest from coming back, and none of it may block a spawn.
   */
  async reapply(instanceId: string): Promise<{ restored: number; failed: number }> {
    const specs = this.readDecls(instanceId);
    if (specs.length === 0) return { restored: 0, failed: 0 };
    if (!this.capable().ok) return { restored: 0, failed: specs.length };

    let restored = 0;
    let failed   = 0;
    for (const spec of specs) {
      const id = this.mountId(spec.targetAppId, spec.data ? 'data' : 'source');
      if (this.mounts.get(instanceId)?.has(id)) continue;   // already there (adopted)
      try {
        await this.add(instanceId, spec, { persist: false });
        restored++;
      } catch (err) {
        failed++;
        console.warn(`[MountManager] could not restore ${id} into ${instanceId}: ${(err as Error).message}`);
      }
    }
    if (restored || failed) {
      console.log(`[MountManager] reapply ${instanceId}: restored ${restored}, failed ${failed}`);
    }
    return { restored, failed };
  }

  // ─── Queries ───────────────────────────────────────────────────────────

  /** Whether this host supports propagation at all. */
  capable(): { ok: boolean; reason?: string } {
    return this.opts.runner.canPropagateMounts();
  }

  list(instanceId: string): AuraMount[] {
    return [...(this.mounts.get(instanceId)?.values() ?? [])];
  }

  /**
   * The live truth, read from the kernel rather than our cache. The shell's own
   * `/data` is the volume root, so every instance's `.mnt/<app>` bind is visible
   * in the shell's mountinfo — no docker calls needed to enumerate.
   */
  liveMountPaths(): string[] {
    try {
      return readFileSync('/proc/self/mountinfo', 'utf-8')
        .split('\n')
        .map((l) => l.split(' ')[4] ?? '')
        .filter((p) => p.startsWith(`${this.opts.dataDir}/`) && p.includes(`/${MOUNT_DIR_NAME}/`));
    } catch {
      return [];
    }
  }

  // ─── Path resolution ───────────────────────────────────────────────────

  /** Shell-side path of what we'd mount FROM, for a target app. */
  private resolveSource(targetAppId: string, kind: MountKind): string {
    const manifest = this.opts.registry.getById(targetAppId);
    if (!manifest) throw new Error(`App not found: ${targetAppId}`);
    if (kind === 'source') return manifest.appDir;
    // Data: the app-level dir holding every instance's data. Always under
    // dataDir for all three scopes (system's SOURCE is a host bind, but its
    // DATA still lives on the volume).
    const scope = this.opts.scopeRegistry.getById(manifest.scopeId);
    return join(scope.dataDir, 'apps', targetAppId);
  }

  private mountId(targetAppId: string, kind: MountKind): string {
    return kind === 'data' ? `${targetAppId}:data` : targetAppId;
  }

  /**
   * Which mount root this instance can actually use. Containers spawned before
   * the `/mnt/aura` change don't have it, and mounting into a path the
   * container can't see would succeed on the host and be invisible inside —
   * the worst kind of failure. So we ask the container what it has.
   *
   * Returns the shell-side root dir and the path it appears at inside.
   */
  private rootFor(instanceId: string, consumerDataDir: string): { shellDir: string; containerDir: string } {
    const container = containerNameFor(instanceId);
    try {
      const out = execSync(`docker inspect -f '{{range .Mounts}}{{.Destination}}{{"\\n"}}{{end}}' ${container}`,
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, encoding: 'utf-8' });
      if (out.split('\n').some((d) => d.trim() === MOUNT_ROOT_PATH)) {
        return { shellDir: this.opts.runner.mountRootDir(instanceId), containerDir: MOUNT_ROOT_PATH };
      }
    } catch { /* not inspectable — fall through to the legacy root */ }
    return {
      shellDir: join(consumerDataDir, MOUNT_DIR_NAME),
      containerDir: `/data/${MOUNT_DIR_NAME}`,
    };
  }

  private dirName(targetAppId: string, kind: MountKind): string {
    return kind === 'data' ? `${targetAppId}.data` : targetAppId;
  }

  // ─── Mutations ─────────────────────────────────────────────────────────

  async add(instanceId: string, spec: AddMountSpec, opts: { persist?: boolean } = {}): Promise<AuraMount> {
    const cap = this.capable();
    if (!cap.ok) throw new Error(`mount propagation unavailable: ${cap.reason}`);

    const kind: MountKind = spec.data ? 'data' : 'source';
    const mode: MountMode = spec.mode ?? 'ro';
    const id = this.mountId(spec.targetAppId, kind);

    if (this.mounts.get(instanceId)?.has(id)) {
      throw new Error(`${id} is already mounted into ${instanceId}`);
    }

    const consumerDataDir = this.opts.instanceDataDir(instanceId);
    if (!consumerDataDir) throw new Error(`Instance not found: ${instanceId}`);

    const srcShell = this.resolveSource(spec.targetAppId, kind);
    const dirName  = this.dirName(spec.targetAppId, kind);
    const root     = this.rootFor(instanceId, consumerDataDir);
    const dstShell = join(root.shellDir, dirName);

    // Refuse to mount an app into itself at the same path — a self-bind of the
    // consumer's own data dir would nest the mount root inside its own source.
    if (srcShell === consumerDataDir || dstShell.startsWith(`${srcShell}/`)) {
      throw new Error(`refusing to mount ${spec.targetAppId} into itself (would nest)`);
    }

    const hostSource = this.opts.runner.toDaemonHostPath(srcShell);
    const hostDest   = this.opts.runner.toDaemonHostPath(dstShell);
    const containerPath = `${root.containerDir}/${dirName}`;

    this.runHelper(instanceId, [
      // The SOURCE carries the ro/rw decision — see the module header.
      '-v', `${hostSource}:/src${mode === 'ro' ? ':ro' : ''}`,
      // `/` is a shared mount, so binds made under /host propagate to the host
      // peer group and thence into every slave (i.e. the app containers).
      '-v', '/:/host:rshared',
    ], 'mkdir -p "/host$1" && mount --bind /src "/host$1"', hostDest);

    const mount: AuraMount = {
      id, instanceId, targetAppId: spec.targetAppId, kind, mode,
      containerPath, hostSource, hostDest, createdAt: new Date().toISOString(),
    };

    try {
      this.verify(instanceId, mount);
    } catch (err) {
      // Never leave a mount weaker than advertised. Roll back and surface it.
      try { this.unmountHost(instanceId, hostDest); } catch { /* best effort */ }
      throw err;
    }

    if (!this.mounts.has(instanceId)) this.mounts.set(instanceId, new Map());
    this.mounts.get(instanceId)!.set(id, mount);
    // `persist: false` while reapply() is replaying what is already on disk.
    if (opts.persist !== false) this.writeDecls(instanceId);
    return mount;
  }

  async remove(instanceId: string, mountId: string): Promise<void> {
    const mount = this.mounts.get(instanceId)?.get(mountId);
    if (!mount) throw new Error(`${mountId} is not mounted into ${instanceId}`);
    this.unmountHost(instanceId, mount.hostDest);
    this.mounts.get(instanceId)!.delete(mountId);
    this.writeDecls(instanceId);   // an explicit detach is a change of intent
    if (this.mounts.get(instanceId)!.size === 0) this.mounts.delete(instanceId);
  }

  /**
   * Drop every mount for an instance. Called on stop/kill/crash — a leaked bind
   * pins the source filesystem and makes the app-data volume unremovable.
   * Never throws: teardown paths must not be blocked by a stuck unmount.
   */
  removeAll(instanceId: string): void {
    for (const mount of this.list(instanceId)) {
      try { this.unmountHost(instanceId, mount.hostDest); }
      catch (err) { console.warn(`[MountManager] unmount ${mount.id} failed: ${(err as Error).message}`); }
    }
    this.mounts.delete(instanceId);
  }

  // ─── Reconciliation ────────────────────────────────────────────────────

  /**
   * Mounts live in the HOST kernel, so they survive the shell process entirely.
   * After a shell restart our in-memory map is empty while the binds are still
   * there — invisible, unlistable, and un-unmountable through the API. Worse,
   * a bind under a dead instance's data dir pins the source filesystem and
   * makes the app-data volume unremovable.
   *
   * Read the live set from `/proc/self/mountinfo` (the shell's `/data` IS the
   * volume root, so every instance's binds are visible there), then drop any
   * belonging to an instance that no longer exists.
   *
   * @param liveInstanceIds instances the AppManager currently knows about.
   */
  reconcile(liveInstanceIds: Set<string>): { adopted: number; reaped: number } {
    let adopted = 0;
    let reaped  = 0;

    for (const path of this.liveMountPaths()) {
      const parsed = this.parseMountPath(path);
      if (!parsed) continue;
      const { instanceId, dirName } = parsed;

      if (!liveInstanceIds.has(instanceId)) {
        try {
          this.unmountHost(instanceId, this.opts.runner.toDaemonHostPath(path));
          reaped++;
          console.log(`[MountManager] reaped orphan mount ${dirName} (dead instance ${instanceId})`);
        } catch (err) {
          console.warn(`[MountManager] could not reap ${path}: ${(err as Error).message}`);
        }
        continue;
      }

      // Live instance: re-adopt so the API can see and detach it. Mode is read
      // back from the kernel rather than assumed — we don't know what a
      // previous shell asked for, only what actually exists now.
      const isData = dirName.endsWith('.data');
      const targetAppId = isData ? dirName.slice(0, -'.data'.length) : dirName;
      const mount: AuraMount = {
        id: isData ? `${targetAppId}:data` : targetAppId,
        instanceId, targetAppId,
        kind: isData ? 'data' : 'source',
        mode: this.readModeAt(path),
        containerPath: path.includes(`/${MOUNT_DIR_NAME}/`)
          ? `/data/${MOUNT_DIR_NAME}/${dirName}`
          : `${MOUNT_ROOT_PATH}/${dirName}`,
        hostSource: '(adopted — source unknown)',
        hostDest: this.opts.runner.toDaemonHostPath(path),
        createdAt: new Date().toISOString(),
      };
      if (!this.mounts.has(instanceId)) this.mounts.set(instanceId, new Map());
      this.mounts.get(instanceId)!.set(mount.id, mount);
      adopted++;
    }

    // An adopted mount was declared by someone, even if the shell that recorded
    // it is gone — persist it so the next restart can re-apply rather than
    // adopt-or-lose. Pre-existing mounts thus become durable on first contact.
    for (const instanceId of this.mounts.keys()) this.writeDecls(instanceId);

    if (adopted || reaped) console.log(`[MountManager] reconcile: adopted ${adopted}, reaped ${reaped}`);
    return { adopted, reaped };
  }

  /**
   * Pull the instanceId + mounted dir name out of a shell-side mount path.
   * Handles both roots:
   *   <dataDir>/aura/mounts/<instanceId>/<dirName>            (canonical)
   *   <dataDir>/scopes/.../apps/<appId>/<instanceId>/.mnt/<dirName>  (legacy)
   */
  private parseMountPath(path: string): { instanceId: string; dirName: string } | null {
    const canonical = path.match(/\/aura\/mounts\/([^/]+)\/([^/]+)$/);
    if (canonical) return { instanceId: canonical[1]!, dirName: canonical[2]! };
    const legacy = new RegExp(`/([^/]+)/${MOUNT_DIR_NAME}/([^/]+)$`).exec(path);
    if (legacy) return { instanceId: legacy[1]!, dirName: legacy[2]! };
    return null;
  }

  /** Read a mount's actual ro/rw state from the shell's own mountinfo. */
  private readModeAt(path: string): MountMode {
    try {
      const line = readFileSync('/proc/self/mountinfo', 'utf-8')
        .split('\n').find((l) => l.split(' ')[4] === path);
      return (line?.split(' ')[5] ?? '').split(',').includes('ro') ? 'ro' : 'rw';
    } catch { return 'rw'; }
  }

  // ─── Helper container ──────────────────────────────────────────────────

  /**
   * Run a privileged throwaway container to do the (un)mount. The shell has no
   * CAP_SYS_ADMIN and its own mounts are slave-only, so it cannot mount itself.
   * Mirrors the helper pattern in @aura/app-sdk's sidecars.
   *
   * Path arguments are passed as positional argv, never interpolated into the
   * shell string — they come from `docker volume inspect`, not a literal.
   */
  private runHelper(instanceId: string, mounts: string[], script: string, ...args: string[]): void {
    execFileSync('docker', [
      'run', '--rm', '--privileged',
      '--label', 'aura.mount=1',
      '--label', `aura.parent=${instanceId}`,
      ...mounts,
      HELPER_IMAGE,
      '/bin/sh', '-euc', script, '_', ...args,
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  }

  private unmountHost(instanceId: string, hostDest: string): void {
    // Lazy fallback so a shell sitting inside the mount can't block detach;
    // a lazy detach still propagates.
    this.runHelper(instanceId, ['-v', '/:/host:rshared'],
      'umount "/host$1" 2>/dev/null || umount -l "/host$1"; rmdir "/host$1" 2>/dev/null || true',
      hostDest);
  }

  // ─── Verification ──────────────────────────────────────────────────────

  /**
   * Confirm the mount actually landed in the target container with the mode we
   * promised. Reading the container's own mountinfo needs no privileges.
   * Guards against the two silent failures: propagation not arriving at all,
   * and a "read-only" mount that is really read-write.
   */
  private verify(instanceId: string, mount: AuraMount): void {
    const container = containerNameFor(instanceId);
    let info = '';
    try {
      info = execSync(`docker exec ${container} cat /proc/self/mountinfo`,
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, encoding: 'utf-8' });
    } catch {
      // Consumer isn't a running container (proot, or already gone). We can't
      // verify, so don't claim we did.
      console.warn(`[MountManager] could not verify ${mount.id} in ${instanceId} (not a running container)`);
      return;
    }
    const line = info.split('\n').find((l) => l.split(' ')[4] === mount.containerPath);
    if (!line) {
      throw new Error(`mount did not propagate into ${instanceId} at ${mount.containerPath}`);
    }
    const opts = line.split(' ')[5] ?? '';
    const isRo = opts.split(',').includes('ro');
    if (mount.mode === 'ro' && !isRo) {
      throw new Error(
        `refusing mount: requested read-only but ${mount.containerPath} is read-write in ${instanceId}`,
      );
    }
  }
}
