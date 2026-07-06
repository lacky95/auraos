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
  //   • user/global → DON'T run workspace pnpm install. These apps live
  //     outside the workspace globs; their `@aura/*` deps resolve at app-
  //     start time via `aura sdk install` (synth entrypoint hooks it in).
  //     Their other deps install on first container spawn via the existing
  //     `npm install --prefer-offline` block in SYNTHESISED_ENTRYPOINT.
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
    console.log(`[scaffold] ${appId} scoped to '${scope}'; skipping workspace pnpm install (deps resolve at app-start time).`);
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

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
