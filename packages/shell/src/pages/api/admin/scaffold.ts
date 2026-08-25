import type { APIRoute } from 'astro';
import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, normalize, dirname, resolve } from 'node:path';
import { getAppManager } from '@aura/core';

/**
 * Server-side app scaffolding.
 *
 * Why this exists: container-sandbox apps (Terminal, etc.) get a SLICED bind
 * of `/workspace/apps` — only their own `apps/<self>` subdir is visible.
 * Running `aura dev new com.example.foo` from inside such a container would
 * write `/workspace/apps/com.example.foo` into the container's overlay
 * filesystem, which the host AppManager never sees. Routing the write
 * through the shell (which has the full `/workspace/apps` mount via the
 * project-root bind) makes scaffolding work from anywhere — terminal proots,
 * sibling containers, the host shell. AppRegistry's chokidar watcher then
 * picks up the new manifest automatically.
 *
 * Same idea as /api/admin/cap, which exists for the same reason (cap install
 * needs apt/gnupg + write access to /os/toolchain).
 */

/** Fallback when no scope was sent (legacy callers). System scope keeps the
 *  pre-multi-scope behaviour: writes into the monorepo's apps/ + runs
 *  workspace pnpm install. */
const SYSTEM_APPS_DIR = process.env['AURA_APPS_DIR'] ?? '/workspace/apps';

type ScopeId = 'system' | 'global' | 'user';
const ALLOWED_SCOPES: readonly ScopeId[] = ['system', 'global', 'user'];

/** Look up the scope's host-side apps directory via AppManager's ScopeRegistry.
 *  Returns null on unknown scope. */
function resolveScopeAppsDir(scope: ScopeId): string | null {
  try {
    const mgr = getAppManager();
    const def = mgr.getScopeDefinitions().find((s) => s.id === scope);
    return def?.appsDir ?? null;
  } catch {
    // AppManager not yet initialised — fall back to system path for the
    // common "scaffolding right after first boot" case.
    return scope === 'system' ? SYSTEM_APPS_DIR : null;
  }
}

// Enforce reverse-domain notation server-side too — never trust the client's
// validation alone. Same regex AppManifestSchema uses.
const APP_ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

interface FileEntry {
  /** Path relative to apps/<appId>/. Must not escape the app dir. */
  relPath: string;
  /** UTF-8 file contents. Binary files aren't supported (scaffolding doesn't need them). */
  content: string;
  /** Optional unix mode (e.g. 0o755 for shell scripts). */
  mode?: number;
}

interface ScaffoldRequest {
  appId: string;
  /** When true, overwrite an existing apps/<appId>/ dir. */
  force?: boolean;
  /** Rendered template payload (placeholders already substituted client-side). */
  files: FileEntry[];
  /** Where to install. Default 'user' (the most common case for `aura dev new`).
   *  'system' keeps the legacy behaviour — apps go into the monorepo's
   *  apps/ dir + workspace pnpm install runs. */
  scope?: ScopeId;
}

export const POST: APIRoute = async ({ request }) => {
  let body: ScaffoldRequest;
  try { body = await request.json() as ScaffoldRequest; }
  catch { return json({ error: 'invalid-json' }, 400); }

  const { appId, force, files } = body;
  const scope: ScopeId = (body.scope && ALLOWED_SCOPES.includes(body.scope)) ? body.scope : 'user';
  if (!appId || !APP_ID_RE.test(appId)) {
    return json({ error: 'invalid-app-id', message: `appId must match reverse-domain notation (got ${JSON.stringify(appId)}).` }, 400);
  }
  if (!Array.isArray(files) || files.length === 0) {
    return json({ error: 'no-files', message: 'files[] is required and must be non-empty.' }, 400);
  }
  // Refuse oversized payloads — scaffolding is tiny (the template is ~10
  // files, ~30 KB total). A 1 MB ceiling catches misuse without forcing us
  // to think about streaming.
  const totalBytes = files.reduce((n, f) => n + (f.content?.length ?? 0), 0);
  if (totalBytes > 1_000_000) {
    return json({ error: 'payload-too-large', bytes: totalBytes }, 413);
  }

  // Scope-aware destination: system → workspace's apps/, user/global →
  // /data/scopes/{users/default,global}/apps/<id>. The shell's ScopeRegistry
  // already creates these dirs on first access (see ScopeRegistry.ensure()).
  const appsDir = resolveScopeAppsDir(scope);
  if (!appsDir) {
    return json({ error: 'unknown-scope', message: `Unknown scope '${scope}'. Expected one of: ${ALLOWED_SCOPES.join(', ')}.` }, 400);
  }
  // Make sure the scope's apps dir exists — for non-system scopes on first
  // boot it may not have been created yet.
  try { mkdirSync(appsDir, { recursive: true }); } catch { /* best-effort */ }
  const dest = join(appsDir, appId);
  if (existsSync(dest) && !force) {
    return json({ error: 'exists', message: `${dest} already exists. Pass force=true to overwrite.` }, 409);
  }

  // Path traversal guard: every file's resolved path must stay under the
  // app's own directory. Reject `..` segments, absolute paths, and any
  // attempt to drop a manifest into a sibling app.
  for (const f of files) {
    if (typeof f.relPath !== 'string' || typeof f.content !== 'string') {
      return json({ error: 'malformed-file', file: String(f?.relPath) }, 400);
    }
    if (f.relPath.startsWith('/') || f.relPath.includes('\0')) {
      return json({ error: 'unsafe-path', file: f.relPath }, 400);
    }
    const resolved = normalize(join(dest, f.relPath));
    if (!resolved.startsWith(dest + '/') && resolved !== dest) {
      return json({ error: 'path-escape', file: f.relPath, resolved }, 400);
    }
  }

  // Write everything. Errors here are 500s — partial writes are left in
  // place so the caller can inspect with `ls`; a future iteration could
  // stage into a temp dir + rename atomically.
  try {
    mkdirSync(dest, { recursive: true });
    for (const f of files) {
      const target = join(dest, f.relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content);
      if (f.mode) chmodSync(target, f.mode);
    }
  } catch (err) {
    return json({ error: 'write-failed', message: (err as Error).message }, 500);
  }

  // Register the new app with pnpm so its workspace-dep symlinks (@aura/
  // app-sdk, astro, etc.) get created under apps/<id>/node_modules. Without
  // this, the next `aura app start <id>` spawns a container, hits the
  // synthesized entrypoint, can't find `node_modules/.bin/astro` (the
  // workspace root doesn't hoist astro since each app declares its own),
  // and the container dies before the health check.
  //
  // Scope semantics:
  //   • system → run `pnpm install` at workspace root. `pnpm-workspace.yaml`
  //     globs `apps/*` so the new member auto-registers.
  //   • user/global → install INTO the app's own dir: `pnpm install` (astro +
  //     adapter, resolved from the shared store) followed by `aura sdk install`
  //     (@aura/* from the OCI registry). We do this here, at scaffold time,
  //     rather than leaning on the SYNTHESISED_ENTRYPOINT's first-boot install:
  //     a cold `npm install` of a fresh app overruns ProotRunner's 30s health
  //     window, so the very first `aura app start` would time out. Installing
  //     now means the app is launch-ready and the entrypoint's install block is
  //     a no-op (node_modules/.bin/astro + node_modules/@aura already present).
  let installOk = true;
  let installError: string | undefined;
  if (scope === 'system') {
    const workspaceRoot = resolve(appsDir, '..');
    const install = spawnSync('pnpm', ['install', '--prefer-offline'], {
      cwd: workspaceRoot,
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    installOk = install.status === 0;
    if (!installOk) {
      installError = (install.stderr ?? install.error?.message ?? '').slice(0, 400);
      console.warn(`[scaffold] pnpm install after ${appId} failed:`, installError);
    }
  } else {
    const step = installUserAppDeps(dest);
    installOk = step.ok;
    installError = step.error;
    if (!installOk) console.warn(`[scaffold] dep install for ${appId} failed:`, installError);
  }

  // AppRegistry's chokidar watcher (packages/core/src/app-manager/AppRegistry.ts)
  // picks up the new manifest file automatically — no explicit reload call
  // needed. The chokidar `add` event fires within ~100 ms and triggers
  // `loadManifestFile`, which emits `app:installed` on the OsEventBus.
  return json({
    ok: true, appId, scope, dest, fileCount: files.length,
    installed: installOk,
    ...(installError ? { installError } : {}),
  });
};

/**
 * Install a user/global-scope app's dependencies into its own dir so the very
 * first `aura app start` launches inside the 30s health window. Two steps,
 * mirroring what SYNTHESISED_ENTRYPOINT would otherwise do on first boot:
 *   1. `pnpm install` — astro + @astrojs/node, resolved from the shared store
 *      (fast + offline-capable). The app lives outside the pnpm workspace, so
 *      this installs into `<dest>/node_modules` rather than hoisting to root.
 *      `@aura/*` deps sit in `auraDependencies`, which pnpm ignores.
 *   2. `aura sdk install` — pulls `@aura/*` from the local OCI registry into
 *      `<dest>/node_modules/@aura/*`.
 * Never throws — a failed install shouldn't roll back the scaffold; the caller
 * surfaces `installError` and the first-boot entrypoint install remains a
 * fallback.
 */
function installUserAppDeps(dest: string): { ok: boolean; error?: string } {
  const pnpm = spawnSync('pnpm', ['install', '--prefer-offline'], {
    cwd: dest,
    encoding: 'utf-8',
    timeout: 180_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Judge pnpm by its ARTIFACT, not its exit code: pnpm 10/11 exits non-zero
  // on `ERR_PNPM_IGNORED_BUILDS` (it declines to run esbuild/sharp build
  // scripts by default) even though the install itself fully succeeded. Those
  // native postinstalls aren't needed — Vite loads esbuild's prebuilt
  // `@esbuild/<platform>` binary directly — so a populated `.bin/astro` is the
  // real success signal. Only a MISSING astro bin is a genuine failure.
  if (!existsSync(join(dest, 'node_modules', '.bin', 'astro'))) {
    return { ok: false, error: describeSpawnFailure('pnpm install', pnpm) };
  }
  // `aura sdk install` pulls @aura/* from the OCI registry via oras. Keep its
  // output (no --quiet) so a registry/network failure surfaces a real message
  // instead of an empty string. Inherit the shell's env explicitly so the
  // shim resolves the registry host + toolchain the same way it does for a
  // human-run `aura sdk install`.
  const sdk = spawnSync('aura', ['sdk', 'install'], {
    cwd: dest,
    env: process.env,
    encoding: 'utf-8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (sdk.status !== 0 || !existsSync(join(dest, 'node_modules', '@aura'))) {
    return { ok: false, error: describeSpawnFailure('aura sdk install', sdk) };
  }
  return { ok: true };
}

/** Build a non-empty error string from a spawnSync result — prefer stderr,
 *  then stdout, then the spawn error, then a status/signal fallback so the
 *  caller never surfaces an empty "(unknown)". */
function describeSpawnFailure(label: string, r: ReturnType<typeof spawnSync>): string {
  const out = [r.stderr, r.stdout].map((s) => (s ?? '').toString().trim()).filter(Boolean).join('\n');
  const detail = out || r.error?.message || `exited with ${r.signal ? `signal ${r.signal}` : `status ${r.status}`}`;
  return `${label}: ${detail}`.slice(0, 600);
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
