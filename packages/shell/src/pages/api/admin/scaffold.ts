import type { APIRoute } from 'astro';
import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, normalize, dirname, resolve } from 'node:path';
import { getAppManager, getNexusManager, initRepo } from '@aura/core';
import { auditOwner, ownerAction } from '../../../lib/approvals/admin.ts';
import {
  checkCreateInputs, createRequest, duplicateFile, filesDigest, manifestFromFiles, type CreateFile,
} from '../../../lib/approvals/appCreate.ts';
import { handOwnAppSourceToOwner } from '../../../lib/identityReports.ts';

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

/** relPath: relative to apps/<appId>/, must not escape it; content: UTF-8 (no binaries); mode: optional unix mode. */
type FileEntry = CreateFile;

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
  /** D109 AF2: the requester's summary for the owner (Markdown, at most 8 KiB), bound by digest. */
  summary?: string;
  /** D109: the creation plan (a JSON object), bound by digest; not interpreted yet. */
  plan?: unknown;
}

export const POST: APIRoute = async (ctx) => {
  const { request } = ctx;
  let body: ScaffoldRequest;
  try { body = await request.json() as ScaffoldRequest; }
  catch { return json({ error: 'invalid-json' }, 400); }

  const { appId, force, files } = body;
  const scope: ScopeId = (body.scope && ALLOWED_SCOPES.includes(body.scope)) ? body.scope : 'user';
  if (!appId || !APP_ID_RE.test(appId)) {
    return json({
      error: 'invalid-app-id', category: !appId ? 'missing-input' : 'invalid-input',
      message: `appId must match reverse-domain notation (got ${JSON.stringify(appId)}).`,
      missing: [{ input: 'appId', kind: 'field', expects: 'reverse-domain id, e.g. com.example.notes' }],
    }, 400);
  }
  if (!Array.isArray(files) || files.length === 0) {
    return json({
      error: 'no-files', category: 'missing-input', message: 'files[] is required and must be non-empty.',
      missing: [{ input: 'files', kind: 'field', expects: 'the rendered template: [{relPath, content, mode?}]' }],
    }, 400);
  }
  // Refuse oversized payloads — scaffolding is tiny (the template is ~10
  // files, ~30 KB total). A 1 MB ceiling catches misuse without forcing us
  // to think about streaming.
  const totalBytes = files.reduce((n, f) => n + (f.content?.length ?? 0), 0);
  if (totalBytes > 1_000_000) {
    return json({ error: 'payload-too-large', category: 'invalid-input', bytes: totalBytes }, 413);
  }

  // Scope-aware destination: system → workspace's apps/, user/global →
  // /data/scopes/{users/default,global}/apps/<id>. The shell's ScopeRegistry
  // already creates these dirs on first access (see ScopeRegistry.ensure()).
  const appsDir = resolveScopeAppsDir(scope);
  if (!appsDir) {
    return json({ error: 'unknown-scope', category: 'invalid-input', message: `Unknown scope '${scope}'. Expected one of: ${ALLOWED_SCOPES.join(', ')}.` }, 400);
  }
  const dest = join(appsDir, appId);

  // Path traversal guard: every file's resolved path must stay under the
  // app's own directory. Reject `..` segments, absolute paths, and any
  // attempt to drop a manifest into a sibling app. Checked before the owner
  // is asked: the dialog describes exactly these files.
  for (const f of files) {
    if (typeof f?.relPath !== 'string' || typeof f.content !== 'string') {
      return json({ error: 'malformed-file', category: 'invalid-input', file: String(f?.relPath) }, 400);
    }
    if (f.relPath.startsWith('/') || f.relPath.includes('\0')) {
      return json({ error: 'unsafe-path', category: 'invalid-input', file: f.relPath }, 400);
    }
    const resolved = normalize(join(dest, f.relPath));
    if (!resolved.startsWith(dest + '/') && resolved !== dest) {
      return json({ error: 'path-escape', category: 'invalid-input', file: f.relPath, resolved }, 400);
    }
  }
  // Two entries for one file: the server would read one and write the other.
  const dup = duplicateFile(files);
  if (dup !== null) return json({ error: 'duplicate-file', category: 'invalid-input', file: dup, message: `files[] names ${dup} twice.` }, 422);
  const inputs = checkCreateInputs(body.summary, body.plan);
  if (inputs) return json(inputs.body, inputs.status);
  // The facts the owner decides on come from the manifest being written (D109 AF2).
  const parsed = manifestFromFiles(files, appId);
  if ('status' in parsed) return json(parsed.body, parsed.status);

  // Make sure the scope's apps dir exists — for non-system scopes on first
  // boot it may not have been created yet.
  try { mkdirSync(appsDir, { recursive: true }); } catch { /* best-effort */ }
  if (existsSync(dest) && !force) {
    return json({ error: 'exists', message: `${dest} already exists. Pass force=true to overwrite.` }, 409);
  }
  // Creating an app and overwriting one are the owner's decision on exactly
  // these files (D109 AF2 `app.create`; D50 `admin.change` for an overwrite,
  // which replaces the code that runs under the id and whatever was granted
  // to it). The desktop owner and the host operator act directly.
  const replacing = existsSync(dest) && !!force;
  // A built-in app's code is the AuraOS repo's: never overwritten by a scaffold (D1).
  if (replacing && scope === 'system') {
    return json({ error: 'system-app', message: `${appId} is in the system scope (the AuraOS repo): a scaffold does not overwrite it. Use --scope user.` }, 409);
  }
  const target = {
    via: 'scaffold' as const, appId, scope, dest, replaces: replacing,
    files: { digest: filesDigest(files), count: files.length, bytes: totalBytes },
    ...(body.summary !== undefined ? { summary: body.summary } : {}),
    ...(body.plan !== undefined ? { plan: body.plan } : {}),
  };
  const admin = await ownerAction(ctx, createRequest(parsed.manifest, target));
  if (admin instanceof Response) return admin;
  await auditOwner(admin, replacing ? 'app.scaffold-overwrite' : 'app.create', {
    target: `app:${appId}`, detail: { scope, via: 'scaffold', filesDigest: target.files.digest },
  });

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
      if (f.mode) chmodSync(target, f.mode);
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
