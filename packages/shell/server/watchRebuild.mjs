/**
 * Opt-in "smart reload" for the PRODUCTION shell (AURA_SHELL_WATCH=1):
 * rebuild on source changes and serve the new build without restarting the
 * process — the AppManager, the KV server, running apps and every open
 * socket stay as they are.
 *
 *   change in packages/{shell,core,ui,kv-store,app-sdk}/src (debounced)
 *     → `astro build --outDir dist-g<N>` in a child process (GOMAXPROCS-capped
 *       esbuild, so a rebuild cannot exhaust the container's pids budget)
 *     → server.mjs imports dist-g<N>/server/entry.mjs and routes requests to it
 *     → OsEventBus 'shell:rebuilt' { generation, durationMs, changed }
 *       (relayed on socket.io /os-events) → open desktops offer a reload
 *
 * Each generation is a separate output directory, so Node's module cache
 * (keyed by URL) can never mix two builds. Process-wide state the shell pins
 * on globalThis (AppManager, OsEventBus, KV server/redis) is shared by every
 * generation; module-local state in the new build starts fresh, exactly like
 * a Vite SSR module re-execution in dev. Old generations stay loaded in
 * memory (Node cannot unload ESM) — after many rebuilds, `aura restart os`.
 *
 * In dev mode (`astro dev`) none of this runs: Vite's HMR does the job.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync, watch } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const DEBOUNCE_MS = Number(process.env.AURA_SHELL_WATCH_DEBOUNCE_MS ?? 800);
const IGNORE = /(^|[\\/])(node_modules|dist|dist-g\d+|\.astro|\.git)([\\/]|$)|~$|\.swp$/;
const KEEP_GENERATIONS = 2; // the serving one + the previous (for open tabs' lazy chunks)

function log(...args) { console.log('[shell-watch]', ...args); }

/** Directories whose changes rebuild the shell (they are bundled into it). */
export function watchedDirs(shellDir) {
  const pkgs = resolve(shellDir, '..');
  return [
    join(shellDir, 'src'),
    join(pkgs, 'core', 'src'),
    join(pkgs, 'ui', 'src'),
    join(pkgs, 'kv-store', 'src'),
    join(pkgs, 'app-sdk', 'src'),
  ].filter((d) => existsSync(d));
}

/** Output directory of generation `n` (0 = the boot build in dist/). */
export function generationDir(shellDir, n) {
  return n === 0 ? join(shellDir, 'dist') : join(shellDir, `dist-g${n}`);
}

/** Remove generation dirs left by an earlier process (they are not served). */
export function cleanGenerations(shellDir) {
  for (const name of readdirSync(shellDir)) {
    if (/^dist-g\d+$/.test(name)) rmSync(join(shellDir, name), { recursive: true, force: true });
  }
}

function runBuild(shellDir, outDir) {
  const astro = join(shellDir, 'node_modules', 'astro', 'bin', 'astro.mjs');
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [astro, 'build', '--outDir', outDir], {
      cwd: shellDir,
      env: { ...process.env, NODE_ENV: 'production', ASTRO_TELEMETRY_DISABLED: '1', GOMAXPROCS: process.env.GOMAXPROCS ?? '2' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const keep = (b) => { tail = (tail + b.toString()).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('close', (code) => resolveP({ ok: code === 0, tail }));
    child.on('error', (err) => resolveP({ ok: false, tail: String(err) }));
  });
}

/**
 * Start watching. `swap(outDir, generation)` (server.mjs) loads the build in
 * `outDir` and starts serving it; it throws if the build cannot be loaded, in
 * which case the current generation keeps serving.
 */
export function startWatchRebuild({ shellDir, swap }) {
  const repoRoot = resolve(shellDir, '..', '..');
  let generation = 0;
  let timer = null;
  let building = false;
  let pending = new Set();

  const trigger = (file) => {
    if (!file || IGNORE.test(file)) return;
    pending.add(file);
    clearTimeout(timer);
    timer = setTimeout(rebuild, DEBOUNCE_MS);
  };

  async function rebuild() {
    if (building) return; // the finally below re-runs for changes made meanwhile
    building = true;
    const changed = [...pending].map((f) => relative(repoRoot, f)).slice(0, 20);
    pending = new Set();
    const next = generation + 1;
    const outDir = generationDir(shellDir, next);
    const t0 = Date.now();
    log(`rebuilding (generation ${next}) after`, changed.join(', '));
    try {
      rmSync(outDir, { recursive: true, force: true });
      const res = await runBuild(shellDir, outDir);
      if (!res.ok) {
        log(`build failed — still serving generation ${generation}\n${res.tail}`);
        rmSync(outDir, { recursive: true, force: true });
        return;
      }
      await swap(outDir, next);
      generation = next;
      const durationMs = Date.now() - t0;
      log(`serving generation ${generation} (${durationMs} ms)`);
      try {
        const core = await import('@aura/core');
        core.OsEventBus.emit('shell:rebuilt', { generation, durationMs, changed });
      } catch (err) {
        log('could not emit shell:rebuilt:', String(err));
      }
      const stale = generation - KEEP_GENERATIONS;
      if (stale >= 1) rmSync(generationDir(shellDir, stale), { recursive: true, force: true });
    } catch (err) {
      log(`swap failed — still serving generation ${generation}:`, String(err));
      rmSync(outDir, { recursive: true, force: true });
    } finally {
      building = false;
      if (pending.size) { clearTimeout(timer); timer = setTimeout(rebuild, DEBOUNCE_MS); }
    }
  }

  const dirs = watchedDirs(shellDir);
  for (const dir of dirs) {
    watch(dir, { recursive: true }, (_event, name) => trigger(name ? join(dir, name.toString()) : null));
  }
  log('watching', dirs.map((d) => relative(repoRoot, d)).join(', '));
  return { rebuild };
}
