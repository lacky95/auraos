/**
 * Aura Context — the OS-wide env-var / secret manager.
 *
 * v1 scope: a single global **System Context** (`context:system:<KEY>`),
 * read by the OS/master AND mounted into every app container. The schema
 * (`context:app:<appId>:<KEY>`) leaves room for granular per-app App Context
 * later, which is deliberately NOT implemented here.
 *
 * Each entry has a **kind** and an **inject** target set:
 *   • kind `variable` — non-sensitive config; value shown/editable in the UI
 *     and returned by the list API.
 *   • kind `secret`   — sensitive; value NEVER returned by the API, masked in
 *     the UI.
 *   • inject `env`    — injected as `-e KEY=VALUE` at spawn (respawn to change).
 *   • inject `file`   — materialised to `/run/context/<KEY>` (updates live).
 * An entry may target env, file, or both. Values are sealed (AES-256-GCM) at
 * rest so nothing sits plaintext in the Valkey AOF/RDB on disk.
 *
 * Two representations, kept in lock-step by `set`/`del`:
 *   • Valkey (`context:system:<KEY>`) — source of truth: `{ kind, sealed, inject }`.
 *   • Files (`<dataDir>/context/system/<KEY>`) — plaintext, materialised
 *     atomically, ONLY for entries whose inject set contains `file`. This dir
 *     is the mount source for `/run/context` in every app container, so a value
 *     change reaches a RUNNING app on its next file read — no app restart, and
 *     never a master restart (the master reads Valkey live at point-of-use).
 *
 * Access is server-internal only. The public `/api/kv/...` proxy rejects the
 * `context:*` namespace; callers go through `/api/os/context`.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultKv, type KvNamespace } from '@aura/kv-store';
import { OsEventBus } from '../ipc/OsEventBus.js';
import { open, resolveMasterKey, seal } from './seal.js';

/** KV namespace for the v1 global context. */
const SYSTEM_NS: KvNamespace = 'context:system';

/** Context keys are env-var names: uppercase, digits, underscore. */
const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export type ContextKind = 'secret' | 'variable';
export type InjectTarget = 'env' | 'file';
const ALL_TARGETS: readonly InjectTarget[] = ['env', 'file'];

/** Shape stored inside the KvValue.value for each context entry. */
interface StoredContext {
  kind: ContextKind;
  /** base64( iv | tag | ciphertext ) of the plaintext value. */
  sealed: string;
  /** Where the value is injected — non-empty subset of `env` / `file`. */
  inject: InjectTarget[];
}

export interface ContextEntry {
  key: string;
  kind: ContextKind;
  inject: InjectTarget[];
  updatedAt: number;
  /** Plaintext for `variable`; `null` for `secret` (never disclosed). */
  value: string | null;
}

/** Normalise an arbitrary inject value to a valid, deduped, non-empty set. */
export function normaliseInject(raw: unknown): InjectTarget[] {
  if (!Array.isArray(raw)) return [...ALL_TARGETS];
  const set = ALL_TARGETS.filter((t) => raw.includes(t));
  return set.length ? set : [...ALL_TARGETS];
}

export class ContextStore {
  private readonly dataDir: string;
  private readonly key: Buffer;
  /** Filesystem dir that mounts into containers at `/run/context`. */
  readonly systemDir: string;

  constructor(dataDir: string = process.env['AURA_DATA_DIR'] ?? '/data') {
    this.dataDir = dataDir;
    this.systemDir = join(dataDir, 'context', 'system');
    this.key = resolveMasterKey(dataDir);
  }

  static isValidKey(key: string): boolean {
    return KEY_PATTERN.test(key);
  }

  private static assertKey(key: string): void {
    if (!KEY_PATTERN.test(key)) {
      throw new Error(`invalid context key '${key}' — must match ${KEY_PATTERN.source}`);
    }
  }

  /**
   * Decode a raw stored value into `{ kind, inject, plaintext }`. Tolerates the
   * legacy shapes: a bare sealed string (pre-`kind`), or an object without
   * `inject` (pre-`inject`) — both default to a `secret` injected everywhere.
   */
  private decode(raw: unknown): { kind: ContextKind; inject: InjectTarget[]; plaintext: string } | null {
    if (raw == null) return null;
    if (typeof raw === 'string') {
      return { kind: 'secret', inject: [...ALL_TARGETS], plaintext: open(raw, this.key) };
    }
    const s = raw as Partial<StoredContext>;
    if (typeof s.sealed === 'string') {
      return {
        kind: s.kind === 'variable' ? 'variable' : 'secret',
        inject: normaliseInject(s.inject),
        plaintext: open(s.sealed, this.key),
      };
    }
    return null;
  }

  /**
   * Ensure the mount-source dir exists so docker `volume-subpath` mounts (and
   * proot binds) at spawn time don't fail on a missing path. Idempotent.
   */
  ensureDir(): void {
    mkdirSync(this.systemDir, { recursive: true });
  }

  /**
   * Make File-injected context available INSIDE the master (shell) container,
   * matching the `/run/context` path the apps see. Two best-effort steps
   * (each wrapped in try/catch — a non-root master or a pre-existing mount just
   * skips):
   *   1. Symlink `/run/context` → the live system dir, so `cat /run/context/<KEY>`
   *      works in the master and reflects changes instantly (no restart).
   *   2. Drop `/etc/profile.d/aura-context.sh`, which exports `<KEY>=<value>`
   *      from those files. Login shells source profile.d; non-login interactive
   *      shells (`docker exec bash`, `aura jump -m`) source `/etc/bash.bashrc`
   *      instead, so we also add a guarded line there. Either way a freshly
   *      opened master shell has `$<KEY>` set (already-open shells pick it up on
   *      next shell). A real env var can't change in the running master process
   *      itself without a restart, so this is the no-restart equivalent.
   * Only File-injected entries appear (they're the only ones with files);
   * env-only entries remain app-container-only.
   */
  ensureMasterAccess(): void {
    try {
      if (!existsSync('/run/context')) symlinkSync(this.systemDir, '/run/context');
    } catch { /* not permitted / already a mount — skip */ }
    try {
      const snippet =
        '# AuraOS Context — auto-export File-injected context into shells.\n' +
        'if [ -d /run/context ]; then\n' +
        '  for _f in /run/context/*; do\n' +
        '    [ -f "$_f" ] || continue\n' +
        '    _k=$(basename "$_f")\n' +
        '    case "$_k" in *.*) continue;; esac\n' +
        '    export "$_k"="$(cat "$_f")"\n' +
        '  done\n' +
        '  unset _f _k\n' +
        'fi\n';
      writeFileSync('/etc/profile.d/aura-context.sh', snippet, { mode: 0o644 });
    } catch { /* not permitted — skip */ }
    // Non-login interactive shells (docker exec / aura jump -m) source
    // /etc/bash.bashrc, NOT profile.d — hook it too, guarded against dupes.
    try {
      const marker = '# aura-context (auto)';
      let cur = '';
      try { cur = readFileSync('/etc/bash.bashrc', 'utf-8'); } catch { /* file absent */ }
      if (!cur.includes(marker)) {
        appendFileSync(
          '/etc/bash.bashrc',
          `\n${marker}\n[ -f /etc/profile.d/aura-context.sh ] && . /etc/profile.d/aura-context.sh\n`,
        );
      }
    } catch { /* not permitted — skip */ }
  }

  /** Every decoded entry (server-internal — carries plaintext). */
  private async resolveAll(): Promise<Array<{ key: string; kind: ContextKind; inject: InjectTarget[]; plaintext: string; updatedAt: number }>> {
    const kv = defaultKv();
    try {
      const keys = await kv.list(SYSTEM_NS, { limit: 1000 });
      const out: Array<{ key: string; kind: ContextKind; inject: InjectTarget[]; plaintext: string; updatedAt: number }> = [];
      for (const key of keys) {
        const entry = await kv.get(SYSTEM_NS, key);
        const dec = this.decode(entry?.value);
        if (dec) out.push({ key, ...dec, updatedAt: entry?.updatedAt ?? 0 });
      }
      return out;
    } finally {
      await kv.close().catch(() => undefined);
    }
  }

  /**
   * All entries with kind + inject + timestamp. `variable` values are included;
   * `secret` values are always `null` (never disclosed).
   */
  async list(): Promise<ContextEntry[]> {
    const all = await this.resolveAll();
    return all
      .map((e) => ({
        key: e.key,
        kind: e.kind,
        inject: e.inject,
        updatedAt: e.updatedAt,
        value: e.kind === 'variable' ? e.plaintext : null,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Decrypt a single value regardless of kind. Server-internal callers only. */
  async get(key: string): Promise<string | null> {
    ContextStore.assertKey(key);
    const kv = defaultKv();
    try {
      const entry = await kv.get(SYSTEM_NS, key);
      return this.decode(entry?.value)?.plaintext ?? null;
    } finally {
      await kv.close().catch(() => undefined);
    }
  }

  /** Upsert: seal into Valkey with its kind + inject targets, sync the file, broadcast. */
  async set(
    key: string,
    value: string,
    kind: ContextKind = 'secret',
    inject: InjectTarget[] = [...ALL_TARGETS],
  ): Promise<ContextEntry> {
    ContextStore.assertKey(key);
    const targets = normaliseInject(inject);
    const kv = defaultKv();
    try {
      const payload: StoredContext = { kind, sealed: seal(value, this.key), inject: targets };
      const stored = await kv.set(SYSTEM_NS, key, payload);
      // Only materialise a file when `file` is a target; otherwise make sure a
      // stale file from a previous config is removed (e.g. toggled to env-only).
      if (targets.includes('file')) this.writeFile(key, value);
      else this.removeFile(key);
      OsEventBus.emit('context:changed', { scope: 'system', key, deleted: false });
      return { key, kind, inject: targets, updatedAt: stored.updatedAt, value: kind === 'variable' ? value : null };
    } finally {
      await kv.close().catch(() => undefined);
    }
  }

  /** Remove from Valkey + unlink the file + broadcast. */
  async del(key: string): Promise<boolean> {
    ContextStore.assertKey(key);
    const kv = defaultKv();
    try {
      const removed = await kv.del(SYSTEM_NS, key);
      if (removed) {
        this.removeFile(key);
        OsEventBus.emit('context:changed', { scope: 'system', key, deleted: true });
      }
      return removed;
    } finally {
      await kv.close().catch(() => undefined);
    }
  }

  /**
   * Decrypted `KEY → value` map for spawn-time `-e` env injection. Only entries
   * whose inject set contains `env`. Read live from Valkey on every spawn so a
   * respawned app gets current values.
   */
  async resolveEnv(): Promise<Record<string, string>> {
    const all = await this.resolveAll();
    const env: Record<string, string> = {};
    for (const e of all) if (e.inject.includes('env')) env[e.key] = e.plaintext;
    return env;
  }

  /**
   * Rebuild the whole `system/` dir from Valkey. Called once at OS boot so the
   * files exist before the first app mount. Writes files ONLY for entries whose
   * inject set contains `file`, and prunes every other file (deleted keys or
   * entries toggled to env-only).
   */
  async materializeAll(): Promise<void> {
    this.ensureDir();
    this.ensureMasterAccess();
    const all = await this.resolveAll();
    const fileEntries = all.filter((e) => e.inject.includes('file'));
    const want = new Set(fileEntries.map((e) => e.key));
    let existing: string[] = [];
    try { existing = readdirSync(this.systemDir); } catch { /* just created */ }
    for (const name of existing) {
      if (!want.has(name)) {
        try { rmSync(join(this.systemDir, name), { force: true }); } catch { /* ignore */ }
      }
    }
    for (const e of fileEntries) this.writeFile(e.key, e.plaintext);
  }

  /** Atomic write (tmp + rename) so a reader never sees a half-written file. */
  private writeFile(key: string, value: string): void {
    this.ensureDir();
    const dest = join(this.systemDir, key);
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, value, { mode: 0o600 });
    renameSync(tmp, dest);
  }

  private removeFile(key: string): void {
    try { rmSync(join(this.systemDir, key), { force: true }); } catch { /* already gone */ }
  }
}
