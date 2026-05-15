/**
 * Embedded Redis lifecycle. The shell process owns ONE running Redis at
 * a time; everything else (Settings UI, app iframes, CLI) talks to it
 * via the shell's HTTP KV API.
 *
 * Why redis-memory-server: it downloads the real Redis binary into a
 * cache dir, spawns it as a child process, and gives us its URI. We
 * point its `--dir` at `/data/kv` and pass `--save 60 1 --appendonly yes`
 * so the database survives container restarts via RDB + AOF on the
 * mounted `/data` volume.
 *
 * Lifetime: a globalThis singleton matches the AppManager / OsEventBus
 * pattern (`packages/core/src/app-manager/AppManager.ts:931-963`,
 * `packages/core/src/ipc/OsEventBus.ts:48-55`) so the shell's
 * soft-restart endpoint reuses the running Redis instead of killing +
 * respawning it on every code-reload tick.
 */

import { mkdirSync } from 'node:fs';
import { RedisMemoryServer } from 'redis-memory-server';

const DEFAULT_DATA_DIR = '/data/kv';
const DEFAULT_DB_FILE  = 'aura.rdb';

export interface KvServerOpts {
  /** Where Redis writes its RDB + AOF files. Defaults to `/data/kv`. */
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

export class KvServer {
  private server: RedisMemoryServer | null = null;
  private uri:    string | null = null;
  private startingPromise: Promise<string> | null = null;

  /**
   * Start the Redis process and return its URI. Idempotent — subsequent
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

    // Ensure /data/kv exists before Redis tries to write into it. Without
    // this the child errors out with ENOENT and we'd see "did not become
    // ready" mid-spawn.
    mkdirSync(dataDir, { recursive: true });

    this.startingPromise = (async () => {
      const server = new RedisMemoryServer({
        instance: {
          // Note: passing `dir` here is supported by redis-memory-server
          // but doesn't add `--dir` to the binary args. The args[] route
          // is the explicit, version-stable way.
          args: [
            '--dir',         dataDir,
            '--dbfilename',  dbFilename,
            '--save',        `${saveSecs} ${saveChgs}`,
            '--appendonly',  'yes',
            // Per-write fsync would block; default `everysec` is the right
            // trade-off for a config store (lose at most ~1s of writes on
            // hard kill, which the user accepts vs. write-amplification).
            '--appendfsync', 'everysec',
          ],
        },
      });
      await server.start();
      const host = await server.getHost();
      const port = await server.getPort();
      this.server = server;
      this.uri    = `redis://${host}:${port}`;
      console.log(`[KvServer] embedded Redis ready at ${this.uri} (data=${dataDir})`);
      return this.uri;
    })();

    try {
      return await this.startingPromise;
    } finally {
      this.startingPromise = null;
    }
  }

  /** Resolved URI, or null when not started. */
  getUri(): string | null {
    return this.uri;
  }

  isRunning(): boolean {
    return this.uri !== null;
  }

  /**
   * Graceful shutdown. RDB+AOF flush happens automatically as Redis
   * receives SIGTERM. Safe to call even when not started.
   */
  async stop(): Promise<void> {
    if (!this.server) return;
    try {
      await this.server.stop();
    } catch (err) {
      console.warn('[KvServer] stop() failed:', (err as Error).message);
    } finally {
      this.server = null;
      this.uri    = null;
    }
  }
}

/**
 * Singleton on globalThis — soft-restart paths reuse the same Redis
 * instance, so we don't pay the spawn cost on every code reload.
 */
const GLOBAL_KEY = '__aura_kv_server__';
type GlobalWithKv = typeof globalThis & { [GLOBAL_KEY]?: KvServer };

const existing = (globalThis as GlobalWithKv)[GLOBAL_KEY];
export const kvServer: KvServer = existing ?? new KvServer();
if (!existing) (globalThis as GlobalWithKv)[GLOBAL_KEY] = kvServer;
