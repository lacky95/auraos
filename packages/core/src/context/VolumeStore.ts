/**
 * Aura Context — OS-managed shared **volumes** (Phase 1).
 *
 * The storage half of the Context system (env/secrets live in ContextStore).
 * A Context Volume is a named, persistent directory the user creates in
 * Settings → Context → Volumes and mounts into apps at a user-chosen path, so
 * apps/agents can share filesystem state between containers.
 *
 * Phase 1 is **global**: every volume is mounted into EVERY app container at
 * its `mountPath` (same model as System Context env). Per-app/per-capability
 * grants and live-attach-without-respawn are Phase 2.
 *
 * Backing: rather than independent docker volumes, each Context Volume is a
 * **subpath of the app-data volume** — `<dataDir>/context/volumes/<name>` —
 * mounted exactly like `/run/context`:
 *   • Container apps: `--mount …,volume-subpath=context/volumes/<name>`
 *   • PRoot apps:     `--bind=<dataDir>/context/volumes/<name>:<mountPath>`
 * So create/remove are plain filesystem ops (no docker-daemon calls) and it
 * works for both runners.
 *
 * Access is server-internal only; the public `/api/kv/...` proxy rejects the
 * `context:*` namespace, so volumes are reachable only via `/api/os/volumes`.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { defaultKv, type KvNamespace } from '@aura/kv-store';
import { OsEventBus } from '../ipc/OsEventBus.js';

const VOLUMES_NS: KvNamespace = 'context:volumes';

/** Volume names: lowercase, digits, hyphen/underscore. Becomes a dir name. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export type VolumeMode = 'rw' | 'ro';

/** Shape stored in KV per volume (keyed by name). */
interface StoredVolume {
  mountPath: string;
  mode: VolumeMode;
  createdAt: number;
}

export interface VolumeEntry {
  name: string;
  mountPath: string;
  mode: VolumeMode;
  createdAt: number;
}

/**
 * In-container paths a Context Volume must NOT clobber — every destination the
 * runners already mount, plus the parents that would shadow them and the
 * system dirs. A user mountPath is rejected if it equals or nests under any.
 */
const RESERVED_PREFIXES: readonly string[] = [
  '/', '/workspace', '/data', '/aura', '/mnt/aura', '/home/aura', '/run/context',
  '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/proc', '/sys', '/dev',
  '/os', '/run', '/var', '/root', '/boot',
];

/** True when `p` equals `prefix` or is nested under it. */
function underPrefix(p: string, prefix: string): boolean {
  if (prefix === '/') return true; // nothing may mount at root or its immediate children handled by others
  return p === prefix || p.startsWith(prefix + '/');
}

export class VolumeStore {
  private readonly dataDir: string;
  /** Filesystem dir holding every volume's subpath dir. */
  readonly volumesDir: string;

  constructor(dataDir: string = process.env['AURA_DATA_DIR'] ?? '/data') {
    this.dataDir = dataDir;
    this.volumesDir = join(dataDir, 'context', 'volumes');
  }

  static isValidName(name: string): boolean {
    return NAME_PATTERN.test(name);
  }

  /**
   * Validate a requested mount path. Throws on: non-absolute, trailing slash,
   * reserved/nested-under-reserved, or collision with another volume's path.
   * `others` = the currently-stored paths to check collisions against.
   */
  static validateMountPath(mountPath: string, others: Iterable<string> = []): void {
    if (typeof mountPath !== 'string' || !mountPath.startsWith('/')) {
      throw new Error('mountPath must be an absolute path (start with /)');
    }
    if (mountPath.length > 1 && mountPath.endsWith('/')) {
      throw new Error('mountPath must not end with a trailing slash');
    }
    if (/\/\.\.?(\/|$)/.test(mountPath) || mountPath.includes('\0')) {
      throw new Error('mountPath must not contain "." / ".." segments');
    }
    for (const prefix of RESERVED_PREFIXES) {
      if (prefix === '/') {
        if (mountPath === '/') throw new Error('mountPath / is reserved');
        continue;
      }
      if (underPrefix(mountPath, prefix)) {
        throw new Error(`mountPath '${mountPath}' is reserved (conflicts with ${prefix}) — try /mnt/<name> or /shared/<name>`);
      }
    }
    for (const other of others) {
      if (other === mountPath) throw new Error(`mountPath '${mountPath}' is already used by another volume`);
    }
  }

  private static assertName(name: string): void {
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`invalid volume name '${name}' — must match ${NAME_PATTERN.source}`);
    }
  }

  private static normaliseMode(raw: unknown): VolumeMode {
    return raw === 'ro' ? 'ro' : 'rw';
  }

  /** Ensure a volume's subpath dir exists (mount source for docker/proot). */
  private ensureDir(name: string): void {
    mkdirSync(join(this.volumesDir, name), { recursive: true });
  }

  /** All volumes (name + metadata). For the UI/API. */
  async list(): Promise<VolumeEntry[]> {
    const kv = defaultKv();
    try {
      const names = await kv.list(VOLUMES_NS, { limit: 1000 });
      const out: VolumeEntry[] = [];
      for (const name of names) {
        const rec = await kv.getValue<StoredVolume>(VOLUMES_NS, name);
        if (rec) out.push({ name, mountPath: rec.mountPath, mode: rec.mode, createdAt: rec.createdAt });
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    } finally {
      await kv.close().catch(() => undefined);
    }
  }

  /** Create (or update) a volume: validate, make the dir, persist, broadcast. */
  async create(name: string, mountPath: string, mode: VolumeMode = 'rw'): Promise<VolumeEntry> {
    VolumeStore.assertName(name);
    const m = VolumeStore.normaliseMode(mode);
    const existing = await this.list();
    // Collisions: ignore this same name's own path when updating.
    const otherPaths = existing.filter((v) => v.name !== name).map((v) => v.mountPath);
    VolumeStore.validateMountPath(mountPath, otherPaths);

    const kv = defaultKv();
    try {
      const rec: StoredVolume = { mountPath, mode: m, createdAt: Date.now() };
      await kv.set(VOLUMES_NS, name, rec);
      this.ensureDir(name);
      OsEventBus.emit('context:volumes:changed', { name, deleted: false });
      return { name, mountPath, mode: m, createdAt: rec.createdAt };
    } finally {
      await kv.close().catch(() => undefined);
    }
  }

  /** Remove a volume: drop the record, delete the data dir, broadcast. */
  async remove(name: string): Promise<boolean> {
    VolumeStore.assertName(name);
    const kv = defaultKv();
    try {
      const removed = await kv.del(VOLUMES_NS, name);
      if (removed) {
        try { rmSync(join(this.volumesDir, name), { recursive: true, force: true }); } catch { /* already gone */ }
        OsEventBus.emit('context:volumes:changed', { name, deleted: true });
      }
      return removed;
    } finally {
      await kv.close().catch(() => undefined);
    }
  }

  /**
   * Mount specs for spawn-time injection. Read live from KV on every spawn so a
   * respawned app always gets the current volume set (mirrors ContextStore.resolveEnv).
   */
  async resolveMounts(): Promise<VolumeEntry[]> {
    return this.list();
  }

  /**
   * Ensure every volume's subpath dir exists (so docker volume-subpath mounts /
   * proot binds don't fail on a missing source). Called at OS boot and
   * defensively before each spawn. Best-effort per volume.
   */
  async ensureAll(): Promise<void> {
    mkdirSync(this.volumesDir, { recursive: true });
    const names = await this.list();
    for (const v of names) {
      try { this.ensureDir(v.name); } catch { /* ignore */ }
    }
  }
}
