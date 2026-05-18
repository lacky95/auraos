import type { APIRoute } from 'astro';
import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, normalize, dirname, resolve } from 'node:path';

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

const APPS_DIR = process.env['AURA_APPS_DIR'] ?? '/workspace/apps';
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
}

export const POST: APIRoute = async ({ request }) => {
  let body: ScaffoldRequest;
  try { body = await request.json() as ScaffoldRequest; }
  catch { return json({ error: 'invalid-json' }, 400); }

  const { appId, force, files } = body;
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

  const dest = join(APPS_DIR, appId);
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
  // `pnpm-workspace.yaml` already lists `apps/*` so pnpm picks the new
  // member up automatically; we just have to run the install. The
  // workspace root is the parent of APPS_DIR.
  const workspaceRoot = resolve(APPS_DIR, '..');
  const install = spawnSync('pnpm', ['install', '--prefer-offline'], {
    cwd: workspaceRoot,
    encoding: 'utf-8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const installOk = install.status === 0;
  if (!installOk) {
    // Don't fail the whole scaffold: the files are on disk and the user
    // can `pnpm install` manually. Surface the diagnostic so the CLI can
    // surface it too.
    console.warn(`[scaffold] pnpm install after ${appId} failed:`, install.stderr?.slice(0, 800) || install.error?.message);
  }

  // AppRegistry's chokidar watcher (packages/core/src/app-manager/AppRegistry.ts)
  // picks up the new manifest file automatically — no explicit reload call
  // needed. The chokidar `add` event fires within ~100 ms and triggers
  // `loadManifestFile`, which emits `app:installed` on the OsEventBus.
  return json({
    ok: true, appId, dest, fileCount: files.length,
    installed: installOk,
    ...(installOk ? {} : { installError: (install.stderr ?? install.error?.message ?? '').slice(0, 400) }),
  });
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
