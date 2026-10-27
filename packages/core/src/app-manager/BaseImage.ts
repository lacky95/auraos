import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The `aura-base` image — what every `sandbox: "container"` app and every
 * helper container (mounts, port forwards, sidecar seeding) runs from.
 *
 * `docker compose up` builds it (build-only `aura-base` service), so normally
 * it is already there. This module is the safety net for every other way the
 * shell can come up without it (compose run with `--no-deps`, the image pruned,
 * an older checkout, a remote daemon): `ensureBaseImage()` checks once at boot
 * and, when the image is missing, builds it from `/workspace/Dockerfile` in the
 * background. Container spawns wait for it through `whenBaseImageReady()`.
 *
 * The build pipes the Dockerfile on stdin and sends NO context: the
 * `aura-base` stage only has `RUN` lines, and the checkout is over a gigabyte.
 * The shell has no buildx, so this is the legacy builder — its
 * `Step N/M : <instruction>` lines are the progress. Never set
 * DOCKER_BUILDKIT=1 here: without buildx that fails outright.
 *
 * State lives in `<dataDir>/aura/first-boot/base-image.{json,log}` (same shape
 * as the self-updater's job files); `onChange()` listeners get every state
 * change — the shell turns them into a notification.
 */

export const BASE_IMAGE = process.env['AURA_BASE_IMAGE'] ?? 'aura-base';
export const BASE_IMAGE_TARGET = 'aura-base';

export type BaseImagePhase = 'checking' | 'ready' | 'building' | 'failed';

export interface BaseImageState {
  image: string;
  phase: BaseImagePhase;
  /** Set while building: 0..1 from the builder's `Step N/M`, null before the first step. */
  progress: number | null;
  /** Current builder step, e.g. "RUN apt-get update && …" (trimmed). */
  step?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** True when this process built the image (vs. found it present). */
  built?: boolean;
}

/** Parse one legacy-builder line: `Step 3/7 : RUN apt-get …` → { n: 3, of: 7, text }. */
export function parseBuildStep(line: string): { n: number; of: number; text: string } | null {
  const m = /^Step (\d+)\/(\d+) : (.*)$/.exec(line.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const of = Number(m[2]);
  if (!of || n > of) return null;
  return { n, of, text: m[3]!.trim() };
}

const MAX_STEP_TEXT = 120;
const LOG_TAIL_BYTES = 256 * 1024;
const BUILD_TIMEOUT_MS = 30 * 60_000;

export interface BaseImageDeps {
  /** True when the image exists locally. */
  exists(image: string): boolean;
  /** Run the build; call `onLine` per output line; resolve with the exit code. */
  build(image: string, dockerfile: string, onLine: (line: string) => void): Promise<number>;
}

const defaultDeps: BaseImageDeps = {
  exists(image) {
    const r = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { stdio: 'ignore', timeout: 15_000 });
    return r.status === 0;
  },
  build(image, dockerfile, onLine) {
    return new Promise((resolve) => {
      const env = { ...process.env };
      delete env['DOCKER_BUILDKIT'];
      const child = spawn('docker', ['build', '-t', image, '--target', BASE_IMAGE_TARGET, '-'], {
        stdio: ['pipe', 'pipe', 'pipe'], env,
      });
      const timer = setTimeout(() => { onLine(`[aura] build timed out after ${BUILD_TIMEOUT_MS / 60_000} min`); child.kill('SIGKILL'); }, BUILD_TIMEOUT_MS);
      let buf = '';
      const feed = (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? '';
        for (const l of lines) onLine(l);
      };
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      child.on('error', (err) => { onLine(`[aura] could not run docker: ${err.message}`); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (buf) onLine(buf);
        resolve(code ?? 1);
      });
      child.stdin.end(readFileSync(dockerfile));
    });
  },
};

export interface BaseImageOpts {
  dataDir: string;
  /** Dockerfile holding the `aura-base` stage. Default `/workspace/Dockerfile`. */
  dockerfile?: string;
  image?: string;
  deps?: BaseImageDeps;
}

export class BaseImage {
  readonly image: string;
  private readonly dir: string;
  private readonly dockerfile: string;
  private readonly deps: BaseImageDeps;
  private state: BaseImageState;
  private inflight: Promise<void> | null = null;
  private readonly listeners = new Set<(s: BaseImageState) => void>();

  constructor(opts: BaseImageOpts) {
    this.image = opts.image ?? BASE_IMAGE;
    this.dir = join(opts.dataDir, 'aura', 'first-boot');
    this.dockerfile = opts.dockerfile ?? '/workspace/Dockerfile';
    this.deps = opts.deps ?? defaultDeps;
    this.state = { image: this.image, phase: 'checking', progress: null };
  }

  get current(): BaseImageState { return { ...this.state }; }

  /** Called on every state change; returns the unsubscribe. */
  onChange(fn: (s: BaseImageState) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  get logFile(): string { return join(this.dir, 'base-image.log'); }

  /** Last 256 KB of the latest build transcript, or null when there was none. */
  readLog(): string | null {
    const f = this.logFile;
    if (!existsSync(f)) return null;
    const size = statSync(f).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const fd = openSync(f, 'r');
    try {
      const b = Buffer.alloc(size - start);
      readSync(fd, b, 0, b.length, start);
      return b.toString('utf-8');
    } finally { closeSync(fd); }
  }

  /**
   * Make sure the image exists. Present → resolves at once. Missing → builds it;
   * concurrent callers share the one build. After a failure the next call
   * builds again (that is the retry).
   */
  ensure(): Promise<void> {
    if (this.state.phase === 'ready') return Promise.resolve();
    this.inflight ??= this.run().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /**
   * For spawners: resolves when the image is there. Waits for a running build,
   * starts one when nothing checked yet, and rejects (without rebuilding)
   * after a failed build — the user retries from the notification.
   */
  whenReady(): Promise<void> {
    if (this.state.phase === 'ready') return Promise.resolve();
    if (this.inflight) return this.inflight;
    if (this.state.phase === 'failed') {
      // The image may have been built by hand since (`docker compose build aura-base`).
      if (this.deps.exists(this.image)) { this.set({ phase: 'ready', progress: null }); return Promise.resolve(); }
      return Promise.reject(new Error(`the ${this.image} image is missing and building it failed: ${this.state.error ?? 'unknown error'} — retry from the "Setting up AuraOS" notification or run \`docker compose build aura-base\` on the host`));
    }
    return this.ensure();
  }

  private set(patch: Partial<BaseImageState>): void {
    this.state = { ...this.state, ...patch };
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, 'base-image.json'), JSON.stringify(this.state, null, 2));
    } catch { /* state file is diagnostics only */ }
    for (const fn of this.listeners) {
      try { fn(this.current); } catch (err) { console.warn(`[BaseImage] listener failed: ${(err as Error).message}`); }
    }
  }

  private async run(): Promise<void> {
    if (this.deps.exists(this.image)) {
      this.set({ phase: 'ready', progress: null, error: undefined });
      return;
    }
    if (!existsSync(this.dockerfile)) {
      const error = `${this.dockerfile} not found — cannot build ${this.image}`;
      this.set({ phase: 'failed', error });
      throw new Error(error);
    }
    console.log(`[BaseImage] ${this.image} is missing — building it from ${this.dockerfile} (target ${BASE_IMAGE_TARGET})`);
    mkdirSync(this.dir, { recursive: true });
    const log = createWriteStream(this.logFile, { flags: 'w' });
    this.set({
      phase: 'building', progress: null, step: undefined, error: undefined, built: true,
      startedAt: new Date().toISOString(), finishedAt: undefined,
    });
    let last = '';
    const code = await this.deps.build(this.image, this.dockerfile, (line) => {
      log.write(`${line}\n`);
      if (line.trim()) last = line.trim();
      const s = parseBuildStep(line);
      if (s) {
        const text = s.text.length > MAX_STEP_TEXT ? `${s.text.slice(0, MAX_STEP_TEXT - 1)}…` : s.text;
        // Step N starts now, so N-1 steps are done.
        this.set({ progress: (s.n - 1) / s.of, step: `Step ${s.n} of ${s.of}: ${text}` });
      }
    });
    await new Promise<void>((res) => log.end(res));
    const finishedAt = new Date().toISOString();
    if (code === 0 && this.deps.exists(this.image)) {
      console.log(`[BaseImage] ${this.image} built`);
      this.set({ phase: 'ready', progress: 1, step: undefined, finishedAt });
      return;
    }
    const error = `docker build exited with ${code}${last ? `: ${last}` : ''}`;
    console.error(`[BaseImage] building ${this.image} failed — ${error} (log: ${this.logFile})`);
    this.set({ phase: 'failed', error, finishedAt });
    throw new Error(error);
  }
}

// One per process, on globalThis: the shell can hold more than one copy of this
// module (SSR reloads, the Vite plugins), and every copy must share the build.
const KEY = Symbol.for('aura.baseImage');
type G = typeof globalThis & { [KEY]?: BaseImage };

/** The process-wide instance (created on first use). */
export function getBaseImage(opts?: BaseImageOpts): BaseImage {
  const g = globalThis as G;
  g[KEY] ??= new BaseImage(opts ?? { dataDir: process.env['AURA_DATA_DIR'] ?? '/data' });
  return g[KEY]!;
}

/** Boot hook: check once, build in the background when missing. Never throws. */
export function ensureBaseImage(opts?: BaseImageOpts): Promise<void> {
  return getBaseImage(opts).ensure().catch(() => undefined);
}

/** Await before `docker run <base image>`; rejects after a failed build. */
export function whenBaseImageReady(): Promise<void> {
  return getBaseImage().whenReady();
}
