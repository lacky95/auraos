/**
 * Embedded Valkey lifecycle. The shell process owns ONE running Valkey at
 * a time; everything else (Settings UI, app iframes, CLI) talks to it
 * via the shell's HTTP KV API.
 *
 * Why a plain child process and not `redis-memory-server`: that package
 * downloads + compiles *Redis*, which since 8.x ships under AGPL/RSAL/SSPL.
 * Valkey is the BSD-licensed fork and is wire- and config-compatible, so
 * `ioredis` and every consumer here are unaffected. The binary is baked
 * into the image (`Dockerfile`, copied from `valkey/valkey:8-bookworm`)
 * instead of being fetched at first boot — one less network dependency on
 * a cold start.
 *
 * We point `--dir` at `/data/kv` and pass `--save 60 1 --appendonly yes`
 * so the database survives container restarts via RDB + AOF on the
 * mounted `/data` volume.
 *
 * Lifetime: a globalThis singleton matches the AppManager / OsEventBus
 * pattern (`packages/core/src/app-manager/AppManager.ts:931-963`,
 * `packages/core/src/ipc/OsEventBus.ts:48-55`) so the shell's
 * soft-restart endpoint reuses the running Valkey instead of killing +
 * respawning it on every code-reload tick.
 */

import { mkdirSync, readdirSync, renameSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

const DEFAULT_DATA_DIR = '/data/kv';
const DEFAULT_DB_FILE  = 'aura.rdb';

/** Overridable so a host-side `pnpm test` can point at its own build. */
const VALKEY_BIN = process.env.AURA_VALKEY_BIN ?? 'valkey-server';

/** How long to wait for "Ready to accept connections" before giving up. */
const READY_TIMEOUT_MS = 15_000;

export interface KvServerOpts {
  /** Where Valkey writes its RDB + AOF files. Defaults to `/data/kv`. */
  dataDir?: string;
  /** Filename for the RDB snapshot. Defaults to `aura.rdb`. */
  dbFilename?: string;
  /**
   * `save` config (seconds, write-count). Default `60 1` = snapshot at
   * most once every 60 seconds when ≥1 key changed in that window.
   * AOF (`--appendonly yes`) catches whatever the RDB cadence misses.
   */
  saveSeconds?: number;
  saveChanges?: number;
}

/**
 * Ask the kernel for a free loopback port, then hand it to Valkey. There
 * is a race window between close() and the child's bind(), which is why
 * `start()` retries on a bind failure rather than assuming success.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (addr === null || typeof addr === 'string') {
        probe.close(() => reject(new Error('[KvServer] could not resolve a free port')));
        return;
      }
      const { port } = addr;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Valkey cannot read a snapshot written by Redis 7.4+ — it bails with
 * "Can't handle RDB format version <n>" and exits, which would leave the OS
 * unable to boot on any install that predates the Valkey switch. (Checked
 * against Valkey 8.1 and 9.1: the fork diverged deliberately, so this is not
 * a version lag that a newer Valkey will fix.)
 *
 * Rather than crash, move the unreadable files aside and let Valkey start
 * clean. Nothing is deleted: `os/migrate-redis-to-valkey.mjs` restores the
 * data from the quarantine dir, and the caller logs how.
 *
 * Returns the quarantine path, or null when there was nothing to move.
 */
function quarantineSnapshot(dataDir: string): string | null {
  const stamp  = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const parked = `${dataDir}.redis-${stamp}`;
  let moved = false;
  for (const entry of readdirSync(dataDir)) {
    if (!moved) mkdirSync(parked, { recursive: true });
    renameSync(`${dataDir}/${entry}`, `${parked}/${entry}`);
    moved = true;
  }
  return moved ? parked : null;
}

export class KvServer {
  private child: ChildProcess | null = null;
  private uri:    string | null = null;
  private startingPromise: Promise<string> | null = null;
  /** Registered once per instance so an abrupt shell exit doesn't orphan Valkey. */
  private exitHook: (() => void) | null = null;

  /**
   * Start the Valkey process and return its URI. Idempotent — subsequent
   * calls return the same URI. Concurrent calls share the same promise
   * so we never spawn two binaries in parallel.
   */
  async start(opts: KvServerOpts = {}): Promise<string> {
    if (this.uri) return this.uri;
    if (this.startingPromise) return this.startingPromise;

    const dataDir    = opts.dataDir    ?? DEFAULT_DATA_DIR;
    const dbFilename = opts.dbFilename ?? DEFAULT_DB_FILE;
    const saveSecs   = opts.saveSeconds ?? 60;
    const saveChgs   = opts.saveChanges ?? 1;

    // Ensure /data/kv exists before Valkey tries to write into it. Without
    // this the child errors out with ENOENT and we'd see "did not become
    // ready" mid-spawn.
    mkdirSync(dataDir, { recursive: true });

    this.startingPromise = (async () => {
      let lastErr: Error | null = null;
      let quarantined = false;
      // Retries cover the freePort() race: another process can claim the
      // port between our probe closing and Valkey binding it.
      for (let attempt = 0; attempt < 5; attempt++) {
        const port = await freePort();
        try {
          this.child = await this.spawnValkey(port, dataDir, dbFilename, saveSecs, saveChgs);
        } catch (err) {
          lastErr = err as Error;
          // Match on the server's own message rather than sniffing RDB version
          // bytes: it needs no table of which format each fork can read, and it
          // stays correct if those ranges ever move.
          if (!quarantined && /Can't handle RDB format version/i.test(lastErr.message)) {
            quarantined = true;
            const parked = quarantineSnapshot(dataDir);
            console.warn(
              `[KvServer] ${dataDir} holds a Redis-format snapshot that Valkey cannot read.\n` +
              `           Moved aside to ${parked} — nothing was deleted. Starting with an\n` +
              `           empty store; the OS will boot on defaults.\n` +
              `           Your data is NOT restored yet. To restore it, run this from the\n` +
              `           repo root inside the shell container:\n` +
              `             node os/migrate-redis-to-valkey.mjs recover`,
            );
          }
          continue;
        }
        this.uri = `redis://127.0.0.1:${port}`;
        this.installExitHook();
        console.log(`[KvServer] embedded Valkey ready at ${this.uri} (data=${dataDir})`);
        return this.uri;
      }
      throw new Error(`[KvServer] Valkey did not start: ${lastErr?.message ?? 'unknown error'}`);
    })();

    try {
      return await this.startingPromise;
    } catch (err) {
      // Leave the instance reusable — a caller may retry after fixing the
      // environment (missing binary, unwritable dataDir).
      this.child = null;
      this.uri   = null;
      throw err;
    } finally {
      this.startingPromise = null;
    }
  }

  /**
   * Spawn the binary and resolve once it logs readiness. Rejects (after
   * killing the child) on early exit, spawn failure, or timeout — the
   * caller treats every rejection as "try another port".
   */
  private spawnValkey(
    port: number,
    dataDir: string,
    dbFilename: string,
    saveSecs: number,
    saveChgs: number,
  ): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const child = spawn(VALKEY_BIN, [
        '--bind',        '127.0.0.1',
        '--port',        String(port),
        '--dir',         dataDir,
        '--dbfilename',  dbFilename,
        '--save',        `${saveSecs} ${saveChgs}`,
        '--appendonly',  'yes',
        // Per-write fsync would block; default `everysec` is the right
        // trade-off for a config store (lose at most ~1s of writes on
        // hard kill, which the user accepts vs. write-amplification).
        '--appendfsync', 'everysec',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      let settled = false;
      let log = '';

      const finish = (err: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout?.removeAllListeners('data');
        child.stderr?.removeAllListeners('data');
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        if (err) {
          child.kill('SIGKILL');
          reject(err);
        } else {
          resolve(child);
        }
      };

      const timer = setTimeout(
        () => finish(new Error(`timed out after ${READY_TIMEOUT_MS}ms; output: ${log.trim()}`)),
        READY_TIMEOUT_MS,
      );
      timer.unref();

      const onChunk = (buf: Buffer) => {
        log += buf.toString();
        // Valkey keeps Redis's startup banner wording.
        if (/Ready to accept connections/i.test(log)) finish(null);
      };
      const onError = (err: Error) =>
        finish(new Error(`could not spawn "${VALKEY_BIN}": ${err.message}`));
      const onExit = (code: number | null, signal: string | null) =>
        finish(new Error(`exited early (code=${code} signal=${signal}); output: ${log.trim()}`));

      child.stdout?.on('data', onChunk);
      child.stderr?.on('data', onChunk);
      child.on('error', onError);
      child.on('exit', onExit);
    });
  }

  /**
   * `spawn()` children outlive their parent, so a crash or SIGTERM in the
   * shell would leave Valkey holding /data/kv. Kill it on the way out.
   */
  private installExitHook(): void {
    if (this.exitHook) return;
    this.exitHook = () => { this.child?.kill('SIGTERM'); };
    process.once('exit', this.exitHook);
  }

  /** Resolved URI, or null when not started. */
  getUri(): string | null {
    return this.uri;
  }

  isRunning(): boolean {
    return this.uri !== null;
  }

  /**
   * Graceful shutdown. RDB+AOF flush happens automatically as Valkey
   * receives SIGTERM. Safe to call even when not started.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.uri   = null;
    if (this.exitHook) {
      process.removeListener('exit', this.exitHook);
      this.exitHook = null;
    }
    if (child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      // SIGKILL backstop: a Valkey wedged mid-fsync would otherwise hang
      // the shell's shutdown path forever.
      const kill = setTimeout(() => child.kill('SIGKILL'), 5_000);
      kill.unref();
      child.once('exit', () => { clearTimeout(kill); resolve(); });
      child.kill('SIGTERM');
    });
  }
}

/**
 * Singleton on globalThis — soft-restart paths reuse the same Valkey
 * instance, so we don't pay the spawn cost on every code reload.
 */
const GLOBAL_KEY = '__aura_kv_server__';
type GlobalWithKv = typeof globalThis & { [GLOBAL_KEY]?: KvServer };

const existing = (globalThis as GlobalWithKv)[GLOBAL_KEY];
export const kvServer: KvServer = existing ?? new KvServer();
if (!existing) (globalThis as GlobalWithKv)[GLOBAL_KEY] = kvServer;
