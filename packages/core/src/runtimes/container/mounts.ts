/**
 * Cross-app mounts on the container runtime (Phase 6 D-M): the `mounts`
 * group. MountManager (the kernel) decides what is mounted where (kinds,
 * nesting, the D80 cross-uid plan, persistence, fan-out, authorization) and
 * hands in a resolved bind; this file realises it in a running container.
 *
 * Docker cannot add a mount to a running container, so the bind is made
 * under it, through Linux mount propagation: every app container's `/data`
 * (and its mount root) is a volume-subpath mount that docker leaves as a
 * SLAVE of the host's peer group, so a host-side `mount --bind` under it
 * appears inside the running container at once. The shell has no
 * CAP_SYS_ADMIN and its own mounts are slave-only, so a privileged throwaway
 * helper container does the (un)mount. Read-only is carried by the SOURCE
 * (`:ro`): `remount,ro` does not propagate (see MountManager's header).
 * A D80 idmapped bind runs the session launcher's `idmap-bind` in the same
 * helper.
 *
 * Every bind is verified against the consumer's own `/proc/self/mountinfo`
 * (`verify`); a sidecar image without `cat` is read through a helper that
 * joins its PID namespace. Argv is golden (test/golden-workload-args.test.mjs).
 *
 * The runner's facts are handed in (no runtime import of app-manager, D97).
 */
import { execFileSync, execSync } from 'node:child_process';
import type { RuntimeMountBind, RuntimeMountCheck, RuntimeMountEntry, RuntimeMounts } from '../ari.js';
import { IDMAP_HELPER_PATH, type ContainerMountBackend } from './backends.js';
import { containerName } from './names.js';
import { MOUNT_ROOT_PATH } from '../spawn/paths.js';

/** Separator of a sidecar consumer key: `<instanceId>--<sidecar>`. */
const SIDECAR_SEP = '--';
const isSidecar = (consumer: string): boolean => consumer.includes(SIDECAR_SEP);
const parentOf = (consumer: string): string => {
  const i = consumer.indexOf(SIDECAR_SEP);
  return i === -1 ? consumer : consumer.slice(0, i);
};

/** The container module's `mounts` group over the runner's mount facts. */
export function containerMounts(runner: ContainerMountBackend, opts: { helperImage: string }): RuntimeMounts {
  /**
   * Run a privileged throwaway container to do the (un)mount. Path arguments
   * are passed as positional argv, never interpolated into the shell string.
   */
  const runHelper = (consumer: string, mounts: string[], script: string, ...args: string[]): void => {
    execFileSync('docker', [
      'run', '--rm', '--privileged',
      '--label', 'aura.mount=1',
      '--label', `aura.parent=${parentOf(consumer)}`,
      ...mounts,
      opts.helperImage,
      '/bin/sh', '-euc', script, '_', ...args,
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  };

  /**
   * The consumer container's own mount table, or null when it can't be read.
   * App containers run aura-base (has `cat`). A sidecar may run an image
   * without one (distroless, scratch), so for sidecars fall back to a helper
   * that joins its PID namespace and reads PID 1's view — unprivileged.
   */
  const readMountinfo = (consumer: string): string | null => {
    const container = containerName(consumer);
    try {
      return execFileSync('docker', ['exec', container, 'cat', '/proc/self/mountinfo'],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, encoding: 'utf-8' });
    } catch { /* no container, or no `cat` in it */ }
    if (!isSidecar(consumer)) return null;
    try {
      return execFileSync('docker', ['run', '--rm', '--label', 'aura.mount=1', '--label', `aura.parent=${parentOf(consumer)}`,
        `--pid=container:${container}`, opts.helperImage, 'cat', '/proc/1/mountinfo'],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, encoding: 'utf-8' });
    } catch { return null; }
  };

  const table = (consumer: string): RuntimeMountEntry[] | null => {
    const info = readMountinfo(consumer);
    if (info === null) return null;
    return info.split('\n').filter((l) => l.trim()).map((l) => {
      const f = l.split(' ');
      return { destination: f[4] ?? '', options: (f[5] ?? '').split(',') };
    });
  };

  return {
    capable: () => runner.canPropagateMounts(),
    idmapProbe: () => {
      const probe = runner.canIdmapMounts();
      if (!probe.ok) return probe;
      return runner.idmapHelperHostPath() ? probe : { ok: false };
    },
    rootDir: (consumer) => runner.mountRootDir(consumer),
    hostPath: (shellPath) => runner.toDaemonHostPath(shellPath),
    /**
     * Which mount root this consumer can actually use. Containers spawned
     * before the `/mnt/aura` change don't have it, and mounting into a path
     * the container can't see would succeed on the host and be invisible
     * inside, so the container is asked what it has.
     */
    rootOf(consumer) {
      const container = containerName(consumer);
      try {
        const out = execSync(`docker inspect -f '{{range .Mounts}}{{.Destination}}{{"\\n"}}{{end}}' ${container}`,
          { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, encoding: 'utf-8' });
        if (out.split('\n').some((d) => d.trim() === MOUNT_ROOT_PATH)) return 'canonical';
      } catch { /* not inspectable — fall through to the legacy root */ }
      return 'legacy';
    },
    attach(consumer, bind: RuntimeMountBind) {
      if (bind.idmap) {
        const helper = runner.idmapHelperHostPath();
        if (!helper) throw new Error('idmapped mounts unavailable: no idmap helper');
        // D80: the session launcher's `idmap-bind` (Node has no mount_setattr), in the same helper.
        runHelper(consumer, [
          '-v', `${bind.source}:/src`,
          '-v', '/:/host:rshared',
          '-v', `${helper}:${IDMAP_HELPER_PATH}:ro`,
        ], `mkdir -p "/host$1" && { ${IDMAP_HELPER_PATH} idmap-bind /src "/host$1" "$2" "$3" || { rmdir "/host$1" 2>/dev/null || true; exit 1; }; }`,
        bind.dest, bind.idmap.from, bind.idmap.to);
        return;
      }
      runHelper(consumer, [
        // The SOURCE carries the ro/rw decision — see the header.
        '-v', `${bind.source}:/src${bind.mode === 'ro' ? ':ro' : ''}`,
        // `/` is a shared mount, so binds made under /host propagate to the host
        // peer group and thence into every slave (i.e. the app containers).
        '-v', '/:/host:rshared',
        // On bind failure, remove the dir mkdir just made (rmdir: empty only,
        // so a pre-existing dir with content survives) — a failed mount must
        // not leave a phantom entry under the consumer's mount root.
      ], 'mkdir -p "/host$1" && { mount --bind /src "/host$1" || { rmdir "/host$1" 2>/dev/null || true; exit 1; }; }', bind.dest);
    },
    detach(consumer, dest) {
      // Loop: binds can be STACKED (one per shell generation, before add()
      // learned to adopt survivors) and one umount peels one layer. Lazy
      // fallback so a shell sitting inside the mount can't block detach;
      // a lazy detach still propagates.
      runHelper(consumer, ['-v', '/:/host:rshared'],
        'while umount "/host$1" 2>/dev/null; do :; done; umount -l "/host$1" 2>/dev/null || true; rmdir "/host$1" 2>/dev/null || true',
        dest);
    },
    table,
    /**
     * Whether the bind landed in the consumer with the promised mode: present
     * at `path`, read-only when promised, idmapped when it is a D80 bind.
     * Guards against propagation not arriving and a "read-only" mount that is
     * really read-write.
     */
    verify(consumer, expect): RuntimeMountCheck {
      const t = table(consumer);
      if (t === null) return 'unreadable';
      const entry = t.find((e) => e.destination === expect.path);
      if (!entry) return 'missing';
      if (expect.mode === 'ro' && !entry.options.includes('ro')) return 'writable';
      if (expect.idmap && !entry.options.includes('idmapped')) return 'not-idmapped';
      return 'ok';
    },
  };
}
