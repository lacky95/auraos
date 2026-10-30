#!/usr/bin/env node
/**
 * Production entry of the Aura shell: the `astro build` output (dist/) served
 * by one node http.Server, with the shell's own servers — socket.io
 * `/os-events`, the WS proxy, the SSE mux — attached by the SAME code the dev
 * server uses (server/attach.mjs). Docs: deep-dive/shell-runtime-modes.
 *
 *   pnpm --filter @aura/shell build && pnpm --filter @aura/shell start
 *
 * Env:
 *   HOST / PORT        listen address (default 0.0.0.0:3000)
 *   AURA_SHELL_WATCH=1 rebuild on source changes and serve the new build
 *                      without a restart (server/watchRebuild.mjs)
 *
 * `node server.mjs --check` loads the build and attaches everything, then
 * exits without listening (boot / CI sanity check).
 *
 * The adapter stays in `standalone` mode: its entry exports a `handler` that
 * serves dist/client (hashed /_astro assets, immutable) and falls through to
 * SSR. ASTRO_NODE_AUTOSTART=disabled stops it from opening its own server.
 */
import http from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attachShellServers, escapeProxyViteQuery } from './server/attach.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const check = process.argv.includes('--check');
const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);

process.env.ASTRO_NODE_AUTOSTART = 'disabled';
// Tells GET /api/admin/shell-mode which mode this process is (`astro dev` never runs this file).
process.env.AURA_SHELL_RUNTIME = 'prod';
// attach.mjs reaches our own /api/apps (WS proxy) and origin (SSE mux) on it.
process.env.SHELL_PORT ??= String(port);

/** Load `<outDir>/server/entry.mjs` and return its request handler. */
async function loadBuild(outDir) {
  const entry = join(outDir, 'server', 'entry.mjs');
  if (!existsSync(entry)) {
    throw new Error(`no build at ${entry} — run \`pnpm --filter @aura/shell build\` first`);
  }
  const mod = await import(pathToFileURL(entry).href);
  if (typeof mod.handler !== 'function') throw new Error(`${entry} exports no handler`);
  return { outDir, handler: mod.handler };
}

/**
 * The build to serve: AURA_SHELL_DIST, else dist-prod (what os/boot.sh
 * builds in prod mode, out of reach of a plain `pnpm build`), else dist.
 * A build still being written (an entry that appears within BUILD_WAIT_MS)
 * is waited for instead of exiting at once.
 */
const BUILD_WAIT_MS = 120_000;
async function initialBuildDir() {
  const candidates = process.env.AURA_SHELL_DIST
    ? [join(here, process.env.AURA_SHELL_DIST)]
    : [join(here, 'dist-prod'), join(here, 'dist')];
  const deadline = Date.now() + BUILD_WAIT_MS;
  for (;;) {
    const found = candidates.find((d) => existsSync(join(d, 'server', 'entry.mjs')));
    if (found) return found;
    if (Date.now() > deadline) return candidates[0];   // loadBuild reports it
    console.warn(`[shell] no build yet in ${candidates.join(' or ')} — waiting`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

let current = await loadBuild(await initialBuildDir());
let previous = null;

const server = http.createServer((req, res) => {
  // Same request shape as in dev (see escapeProxyViteQuery in attach.mjs).
  req.url = escapeProxyViteQuery(req.url);
  // After a watched rebuild, tabs still on the previous build lazily load its
  // hashed chunks: serve those from the previous generation until they reload.
  if (previous && req.url?.startsWith('/_astro/')) {
    const path = req.url.split('?')[0];
    if (!existsSync(join(current.outDir, 'client', path)) && existsSync(join(previous.outDir, 'client', path))) {
      previous.handler(req, res);
      return;
    }
  }
  current.handler(req, res);
});

await attachShellServers(server);

if (check) {
  console.log('[shell] check ok: build loaded, servers attached');
  process.exit(0);
}

server.listen(port, host, () => {
  console.log(`[shell] production server on http://${host}:${port}`);
});

if (process.env.AURA_SHELL_WATCH === '1') {
  const { startWatchRebuild, cleanGenerations } = await import('./server/watchRebuild.mjs');
  cleanGenerations(here);
  startWatchRebuild({
    shellDir: here,
    swap: async (outDir) => {
      const next = await loadBuild(outDir);
      previous = current;
      current = next;
    },
  });
}

// Save the desktop before going down (lib/desktopSession.ts): a docker stop or
// recreate is a restart nobody announced. Bounded, well under docker's 10 s.
const SHUTDOWN_HOOK = Symbol.for('aura.shellShutdown');
const SHUTDOWN_MAX_MS = 3_000;
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    const hook = globalThis[SHUTDOWN_HOOK];
    if (typeof hook === 'function') {
      await Promise.race([
        hook().catch((err) => console.warn(`[shell] shutdown save failed: ${err?.message ?? err}`)),
        new Promise((r) => setTimeout(r, SHUTDOWN_MAX_MS)),
      ]);
    }
    server.close();
    process.exit(0);
  });
}
