import type { APIRoute } from 'astro';
import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, normalize, dirname, resolve } from 'node:path';
import {
  getAppManager, getNexusManager, initRepo, installAppDepsUnprivileged, refusedScaffoldFiles, scaffoldFileMode,
  SCAFFOLD_INSTALL_ARGS,
} from '@aura/core';
import { auditOwner, ownerAction } from '../../../lib/approvals/admin.ts';
import { handOwnAppSourceToOwner } from '../../../lib/identityReports.ts';
import { errorResponse } from '../../../lib/appResponse.ts';

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
 * sibling containers, the host shell. The route then registers the app the
 * way an install does (`reloadScopedApp` + `syncAppHost`), so it answers with
 * the app's installation, intents and interfaces in place.
 *
 * Same idea as /api/admin/cap, which exists for the same reason (cap install
 * needs apt/gnupg + write access to /os/toolchain).
 *
 * Nothing in the payload becomes code the shell runs (AF1): files that steer
 * the install or git are refused before anything is written (core
 * scopes/scaffoldPayload.ts), modes are 0644/0755, and the install runs
 * without lifecycle scripts or pnpmfile, as an unprivileged uid for
 * user/global apps (core app-manager/unprivilegedInstall.ts).
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
  /** Optional unix mode: any execute bit gives 0o755, otherwise 0o644 (scaffoldFileMode). */
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

export const POST: APIRoute = async (ctx) => {
  const { request } = ctx;
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

  // Files that would make the install or git run payload code in the shell (AF1).
  const refused = refusedScaffoldFiles(files);
  if (refused.length) {
    return errorResponse(400, {
      error: 'refused-file',
      message: `The scaffold payload contains ${refused.length === 1 ? 'a file' : 'files'} the shell does not install: ${refused.map((r) => r.file).join(', ')}. Nothing was written.`,
      category: 'invalid-request',
      hint: 'Send the files \`aura dev new\` renders; add install settings, hooks or non-registry dependencies after creation, inside the app.',
      details: { refused },
    });
  }

  // Overwriting an EXISTING app replaces the code that runs under its id —
  // and with it whatever was granted to that id. That is the owner's decision
  // on exactly these files (D50, lib/approvals/admin.ts). Creating a new app is not.
  const replacing = existsSync(dest) && !!force;
  // A built-in app's code is the AuraOS repo's: never overwritten by a scaffold (D1).
  if (replacing && scope === 'system') {
    return json({ error: 'system-app', message: `${appId} is in the system scope (the AuraOS repo): a scaffold does not overwrite it. Use --scope user.` }, 409);
  }
  if (replacing) {
    const admin = await ownerAction(ctx, {
      action: 'admin.change', level: 'session', payload: { op: 'scaffold.overwrite', appId, scope, files },
      title: `Overwrite ${appId} with a new scaffold`,
      details: [`Scope: ${scope}`, `Files: ${files.length}`, 'The code that runs under that app id is replaced.',
        'Its grants are revoked; its files and data go to trash (data a kept uninstall left is set aside for that app).'],
    });
    if (admin instanceof Response) return admin;
    await auditOwner(admin, 'app.scaffold-overwrite', { target: `app:${appId}`, detail: { scope } });
  }

  // Replace, never merge (B2/S2): the old app's instances stop, its grants are
  // revoked, its tree goes to trash with its install record, and data a
  // keep-data uninstall left is set aside for its installation instead of
  // being handed to the new app. Same as `aura dev clone --force`.
  const warnings: string[] = [];
  if (replacing) {
    const mgr = getAppManager();
    try { await mgr.stopAll(appId); }
    catch (err) { warnings.push(`stopping ${appId} failed: ${(err as Error).message}; continuing with the overwrite.`); }
    try {
      const aside = await getNexusManager().setAsideForOverwrite(appId, scope);
      if (aside.trash) warnings.push(`previous ${appId} moved to ${aside.trash}`);
      if (aside.retained) warnings.push(`data kept from the uninstalled ${appId} was set aside for that app, not handed to this one`);
    } catch (err) {
      return json({ error: 'overwrite-failed', message: `could not set ${appId} aside: ${(err as Error).message}; nothing was written.` }, 500);
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
      chmodSync(target, scaffoldFileMode(f.mode));
    }
  } catch (err) {
    return json({ error: 'write-failed', message: (err as Error).message }, 500);
  }

  // The app is a git repo from the first minute (D51/Track P): `git init -b
  // main` plus one commit of the scaffold, before deps land (the template's
  // .gitignore keeps node_modules out either way). A forced overwrite of a
  // dir that already is a repo leaves its history alone — the new files show
  // up as changes. A git failure is reported, not fatal: the app is usable.
  let gitCommit: string | null = null;
  let gitError: string | undefined;
  try { gitCommit = initRepo(dest, `Scaffold ${appId} (aura dev new)`); }
  catch (err) { gitError = (err as Error).message; console.warn(`[scaffold] ${gitError}`); }

  // Register it like an install (B1): manifest-derived projections (intents,
  // keymaps, interfaces), mounts, `app:installed`; then its installation and
  // host (D20), awaited. The watcher alone left the projections stale and,
  // over an existing app, made no installation at all.
  try {
    const mgr = getAppManager();
    mgr.reloadScopedApp(appId);
    const hostError = await mgr.syncAppHost(appId, scope);
    if (hostError) warnings.push(`${appId} has no installation record yet (${hostError}); a shell restart allocates it.`);
  } catch (err) {
    warnings.push(`registering ${appId} failed: ${(err as Error).message}; the watcher and the next shell start reconcile it.`);
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
  //   • user/global → install INTO the app's own dir, as an unprivileged uid
  //     with its own store (AF1, installAppDepsUnprivileged): `pnpm install`
  //     (astro + adapter) followed by `aura sdk install` (@aura/* from the OCI
  //     registry). Nothing missing ever falls back to root: the app installs in
  //     its own sandbox at its first start instead. We do this here, at scaffold time,
  //     rather than leaning on the SYNTHESISED_ENTRYPOINT's first-boot install:
  //     a cold `npm install` of a fresh app overruns ProotRunner's 30s health
  //     window, so the very first `aura app start` would time out. Installing
  //     now means the app is launch-ready and the entrypoint's install block is
  //     a no-op (node_modules/.bin/astro + node_modules/@aura already present).
  let installOk = true;
  let installError: string | undefined;
  if (scope === 'system') {
    const workspaceRoot = resolve(appsDir, '..');
    // Root, as the workspace's node_modules is root's: no scripts, no pnpmfile,
    // and the member's files passed refusedScaffoldFiles.
    const install = spawnSync('pnpm', [...SCAFFOLD_INSTALL_ARGS], {
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
    const step = installAppDepsUnprivileged(dest);
    installOk = step.ok;
    installError = step.error;
    if (!installOk) console.warn(`[scaffold] dep install for ${appId} failed:`, installError);
  }

  // The owner's own new app is the owner's (P5-2): its Terminal runs as the owner's uid (stream T).
  const ownership = scope === 'user' ? await handOwnAppSourceToOwner(dest, appId) : null;
  if (ownership) console.warn(`[scaffold] ${appId}: ${ownership}`);

  return json({
    ok: true, appId, scope, dest, fileCount: files.length,
    ...(warnings.length ? { warnings } : {}),
    installed: installOk,
    ...(installError ? { installError } : {}),
    git: { commit: gitCommit, ...(gitError ? { error: gitError } : {}) },
  });
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
