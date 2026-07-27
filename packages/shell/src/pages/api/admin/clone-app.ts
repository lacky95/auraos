import type { APIRoute } from 'astro';
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { join, resolve, relative } from 'node:path';
import {
  AppManifestSchema, AURA_NPMRC, getAppManager, needsNpmrc,
  portPackageJsonForScope, portToolsForScope,
  type ScopeDefinition, type ScopeId,
} from '@aura/core';

/**
 * Server-side app cloning — the engine behind `aura dev clone`.
 *
 * Why this lives in the shell (same reasoning as /api/admin/scaffold, which
 * this route deliberately mirrors): the CLI normally runs inside a container
 * sandbox with a SLICED bind of the apps dir — only the calling app's own
 * subdir is visible. It physically cannot read another app's source tree, let
 * alone a system-scope one. The shell has every scope's appsDir mounted, so
 * the copy happens here and the CLI only sends field overrides.
 *
 * `/api/admin/scaffold` is NOT reusable for this: it takes a UTF-8 `files[]`
 * payload capped at 1 MB and has no notion of copying an existing tree.
 * Real apps carry binary assets and blow past that on both counts.
 *
 * Invariant this route owns: the target scope must be MUTABLE. System apps can
 * be cloned FROM all day long, but never INTO — that scope is the in-repo
 * monorepo (workspace:* deps, pnpm workspace membership) and is marked
 * `immutable` by ScopeRegistry. We check the flag rather than a hardcoded id
 * so the rule survives a future scope being added.
 */

const APP_ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
const SEMVER_RE  = /^\d+\.\d+\.\d+$/;

/** Build artefacts + dep trees that must never follow an app to a new id. */
const COPY_EXCLUDES = ['node_modules', '.next', 'dist', '.astro', '.turbo', '.cache'];

/** Id-rewrite guards: skip anything big or binary rather than corrupting it. */
const REWRITE_MAX_BYTES = 512 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;

interface ManifestPatch {
  name?:        string | null;
  icon?:        string | null;
  description?: string | null;
  version?:     string | null;
}

interface CloneRequest {
  sourceAppId:  string;
  /** Optional — pins which scope to read the source from when an app id is
   *  shadowed across scopes. Without it we take the registry's winner. */
  sourceScope?: ScopeId;
  targetAppId:  string;
  /** Where the clone lands. Must be a mutable scope. Default 'user'. */
  scope?:       ScopeId;
  manifest?:    ManifestPatch;
  /** Substitute sourceAppId → targetAppId inside copied text files. Default true. */
  rewriteIds?:  boolean;
  excludeGit?:   boolean;
  stripPublish?: boolean;
  stripStore?:   boolean;
  withData?:     boolean;
  force?:        boolean;
  dryRun?:       boolean;
}

export const POST: APIRoute = async ({ request }) => {
  let body: CloneRequest;
  try { body = await request.json() as CloneRequest; }
  catch { return json({ error: 'invalid-json' }, 400); }

  const { sourceAppId, targetAppId } = body;
  const rewriteIds = body.rewriteIds !== false;
  const warnings: string[] = [];

  for (const [field, value] of [['sourceAppId', sourceAppId], ['targetAppId', targetAppId]] as const) {
    if (!value || !APP_ID_RE.test(value)) {
      return json({ error: 'invalid-app-id', field, message: `${field} must match reverse-domain notation (got ${JSON.stringify(value)}).` }, 400);
    }
  }
  if (body.manifest?.version != null && !SEMVER_RE.test(body.manifest.version)) {
    return json({ error: 'invalid-version', message: `version must be x.y.z (got ${JSON.stringify(body.manifest.version)}).` }, 400);
  }
  if (body.manifest?.icon != null && (body.manifest.icon.length < 1 || body.manifest.icon.length > 3)) {
    return json({ error: 'invalid-icon', message: 'icon must be 1–3 characters.' }, 400);
  }

  let mgr: ReturnType<typeof getAppManager>;
  try { mgr = getAppManager(); }
  catch (err) { return json({ error: 'app-manager-unavailable', message: (err as Error).message }, 503); }

  const scopes: ScopeDefinition[] = mgr.getScopeDefinitions();

  // ─── Resolve the source ──────────────────────────────────────────────────
  const sourceManifest = mgr.registry.getById(sourceAppId);
  let sourceScope: ScopeId;
  let srcDir: string;
  if (body.sourceScope) {
    const def = scopes.find((s) => s.id === body.sourceScope);
    if (!def) return json({ error: 'unknown-scope', message: `Unknown sourceScope '${body.sourceScope}'.` }, 400);
    sourceScope = def.id;
    srcDir = join(def.appsDir, sourceAppId);
  } else if (sourceManifest) {
    sourceScope = sourceManifest.scopeId;
    srcDir = mgr.registry.getAppDir(sourceAppId);
  } else {
    return json({ error: 'source-not-found', message: `App not installed: ${sourceAppId}` }, 404);
  }
  // Path guard — `getAppDir` returns a registry-computed `<appsDir>/<id>` and
  // the id is already regex-validated, so this is defence against a future
  // regex bypass rather than a live threat. Same idiom as apps/[id]/remove.ts.
  if (!resolve(srcDir).endsWith(`/${sourceAppId}`)) {
    return json({ error: 'path-escape', message: `Refusing to read unexpected path: ${srcDir}` }, 400);
  }
  if (!existsSync(srcDir)) {
    return json({ error: 'source-dir-missing', message: `${srcDir} does not exist on disk.` }, 404);
  }

  // ─── Resolve the target ──────────────────────────────────────────────────
  const targetScopeId: ScopeId = body.scope ?? 'user';
  const targetDef = scopes.find((s) => s.id === targetScopeId);
  if (!targetDef) {
    return json({ error: 'unknown-scope', message: `Unknown scope '${targetScopeId}'. Expected one of: ${scopes.map((s) => s.id).join(', ')}.` }, 400);
  }
  if (targetDef.immutable) {
    return json({
      error: 'scope-immutable',
      message: `Scope '${targetScopeId}' is immutable and cannot receive a clone. System apps can be cloned FROM, not INTO — use scope 'user' or 'global'.`,
    }, 403);
  }
  if (targetAppId === sourceAppId && targetScopeId === sourceScope) {
    return json({
      error: 'same-target',
      message: `${targetAppId} in scope '${targetScopeId}' IS the source. Pick a different app id, or a different scope to shadow it from.`,
    }, 400);
  }

  const dest = join(targetDef.appsDir, targetAppId);
  if (!resolve(dest).endsWith(`/${targetAppId}`)) {
    return json({ error: 'path-escape', message: `Refusing to write unexpected path: ${dest}` }, 400);
  }
  const destExists = existsSync(dest);
  if (destExists && !body.force) {
    return json({ error: 'exists', message: `${dest} already exists. Pass force=true to overwrite.` }, 409);
  }

  // A clone that lands on an id already present in a LOWER-priority scope
  // masks it (AppRegistry picks the highest priority). That's a legitimate
  // "fork an OS app" flow, but the caller should say so out loud.
  const shadowed = scopes
    .filter((s) => s.priority < targetDef.priority && existsSync(join(s.appsDir, targetAppId, 'app.manifest.json')))
    .map((s) => s.id);
  const shadows = shadowed.length > 0 ? shadowed[shadowed.length - 1]! : null;

  const running = mgr.getInstancesByApp(sourceAppId).length;
  if (running > 0) {
    warnings.push(`${sourceAppId} has ${running} running instance(s); the copy is a point-in-time snapshot of its files.`);
  }

  // ─── Stage ───────────────────────────────────────────────────────────────
  // Deliberately NOT `<appsDir>/<id>.tmp.<ts>`: AppRegistry watches
  // `<appsDir>/*/app.manifest.json`, and `*` matches a `.tmp.<ts>` directory
  // just fine — staging there fires a premature `app:installed` for a path
  // that doesn't exist yet. `<dataDir>/clone-staging` is off the watched glob
  // and still on the same filesystem as appsDir (appsDir is `<dataDir>/apps`
  // for every mutable scope), so the final rename stays a real atomic
  // single-syscall move and chokidar observes exactly one `add`.
  const ts = Date.now();
  const staging = join(targetDef.dataDir, 'clone-staging', `${targetAppId}.${ts}`);
  const excludes = body.excludeGit ? [...COPY_EXCLUDES, '.git'] : COPY_EXCLUDES;

  try {
    mkdirSync(join(targetDef.dataDir, 'clone-staging'), { recursive: true });
    try { copyTree(srcDir, staging, excludes); }
    catch (err) { return json({ error: 'copy-failed', message: (err as Error).message }, 500); }

    // ─── Rewrite the manifest ──────────────────────────────────────────────
    const manifestPath = join(staging, 'app.manifest.json');
    if (!existsSync(manifestPath)) {
      return json({ error: 'source-has-no-manifest', message: `${srcDir}/app.manifest.json is missing.` }, 422);
    }
    let m: Record<string, unknown>;
    try { m = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>; }
    catch (err) { return json({ error: 'source-has-no-manifest', message: `Unparseable manifest: ${(err as Error).message}` }, 422); }

    const strippedFields: string[] = [];
    m['id'] = targetAppId;
    applyPatch(m, body.manifest);

    // `dataProvider.authority` is a GLOBAL namespace key — /api/data/<authority>
    // resolves through it. A clone that keeps the source's authority collides
    // with the source, so this rewrite is unconditional (not a user option).
    const dp = m['dataProvider'] as { authority?: string } | undefined;
    if (dp && typeof dp.authority === 'string') {
      if (dp.authority === sourceAppId) {
        dp.authority = targetAppId;
      } else {
        warnings.push(`dataProvider.authority is '${dp.authority}' (not the source's own id) — left as-is; it may collide with the app that owns it.`);
      }
    }

    // `critical` is the one unconditional strip. Critical apps cannot be
    // disabled and the schema says apps a user installs themselves should
    // never set it — a user-scope clone of one would be undisablable.
    if (m['critical'] !== undefined) { delete m['critical']; strippedFields.push('critical'); }

    if (body.stripPublish) {
      if (m['publish'] !== undefined) { delete m['publish']; strippedFields.push('publish'); }
    } else if (m['publish'] !== undefined) {
      warnings.push("manifest keeps the source's `publish` block — `aura nexus app publish` would push this clone to the ORIGINAL's repo/registry.");
    }
    if (body.stripStore && m['store'] !== undefined) { delete m['store']; strippedFields.push('store'); }

    const portedTools = portToolsForScope((m['tools'] as string[] | undefined) ?? [], targetScopeId);
    if (portedTools.length > 0) m['tools'] = portedTools;

    const parsed = AppManifestSchema.safeParse(m);
    if (!parsed.success) {
      return json({
        error: 'manifest-invalid',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        issues: parsed.error.issues,
      }, 422);
    }
    writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');

    // ─── Rewrite package.json + emit .npmrc ────────────────────────────────
    let ported = false;
    const pkgPath = join(staging, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
        if (pkg['name'] === sourceAppId) pkg['name'] = targetAppId;
        const res = portPackageJsonForScope(pkg, targetScopeId, readSdkVersion(scopes));
        ported = res.changed;
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      } catch (err) {
        warnings.push(`package.json could not be rewritten (${(err as Error).message}); left verbatim.`);
      }
    }
    const npmrcPath = join(staging, '.npmrc');
    if (needsNpmrc(targetScopeId) && !existsSync(npmrcPath)) {
      writeFileSync(npmrcPath, AURA_NPMRC);
    }

    // ─── Sweep the source id out of the remaining text files ───────────────
    // Without this the clone still says `com.aura.counter` in its astro
    // header fallbacks, api paths, and anywhere else the id is hardcoded.
    // app.manifest.json is excluded — the structured rewrite above owns it.
    const rewrittenFiles: string[] = [];
    let fileCount = 0;
    let bytes = 0;
    for (const rel of walkFiles(staging, excludes)) {
      const abs = join(staging, rel);
      const size = statSync(abs).size;
      fileCount++;
      bytes += size;
      // A same-id cross-scope clone (the "fork an OS app to shadow it" flow)
      // has nothing to substitute — skip so the report doesn't claim rewrites
      // that replaced the id with itself.
      if (!rewriteIds || sourceAppId === targetAppId || rel === 'app.manifest.json') continue;
      if (size > REWRITE_MAX_BYTES) continue;
      const buf = readFileSync(abs);
      if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue;
      const before = buf.toString('utf-8');
      if (!before.includes(sourceAppId)) continue;
      writeFileSync(abs, before.replaceAll(sourceAppId, targetAppId));
      rewrittenFiles.push(rel);
    }

    if (body.dryRun) {
      return json({
        ok: true, dryRun: true, sourceAppId, sourceScope, targetAppId, scope: targetScopeId,
        dest, fileCount, bytes, ported, rewrittenFiles, strippedFields, shadows, warnings,
      });
    }

    // ─── Land it ───────────────────────────────────────────────────────────
    if (destExists) {
      // Stop instances first so lifecycle hooks can flush state to /data
      // before the files move. Warn-only: a half-stopped app shouldn't block
      // the overwrite the caller explicitly asked for.
      try { await mgr.stopAll(targetAppId); }
      catch (err) { warnings.push(`stopAll(${targetAppId}) failed: ${(err as Error).message} — continuing with the overwrite.`); }
      // Move aside rather than rm -rf, so there's an undo window. Same trash
      // root Nexus uninstall uses.
      const trash = join(targetDef.dataDir, 'nexus', 'trash', `${targetAppId}-${ts}`);
      mkdirSync(join(targetDef.dataDir, 'nexus', 'trash'), { recursive: true });
      moveOrCopy(dest, trash);
      warnings.push(`previous ${targetAppId} moved to ${trash}`);
      // A stale Nexus install record now describes a directory that no longer
      // matches the ref it names.
      const record = join(targetDef.dataDir, 'nexus', 'installed', `${targetAppId}.json`);
      if (existsSync(record)) rmSync(record, { force: true });
    }

    mkdirSync(targetDef.appsDir, { recursive: true });
    try {
      renameSync(staging, dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EXDEV' && code !== 'EBUSY' && code !== 'EPERM') {
        return json({ error: 'land-failed', message: (err as Error).message }, 500);
      }
      cpSync(staging, dest, { recursive: true });
      warnings.push(`landing was non-atomic (rename failed with ${code}); the registry may briefly see a partial app dir.`);
    }

    // ─── Optional: clone the app's runtime data ────────────────────────────
    if (body.withData) {
      const srcData = join(scopeDef(scopes, sourceScope).dataDir, 'apps', sourceAppId);
      const dstData = join(targetDef.dataDir, 'apps', targetAppId);
      if (!existsSync(srcData)) {
        warnings.push(`--with-data: ${srcData} does not exist; nothing to copy.`);
      } else if (existsSync(dstData)) {
        warnings.push(`--with-data: ${dstData} already exists; left untouched.`);
      } else {
        try {
          mkdirSync(join(targetDef.dataDir, 'apps'), { recursive: true });
          copyTree(srcData, dstData, excludes);
          warnings.push(`copied app data → ${dstData}. Note it contains per-instance subdirs named after the SOURCE's instance ids.`);
        } catch (err) {
          warnings.push(`--with-data copy failed: ${(err as Error).message}`);
        }
      }
    }

    // chokidar picks the new dir up on its own within ~100 ms, but a CLI that
    // immediately runs `aura app start` would race it. Reload explicitly, the
    // same way /api/admin/manifest-edit does after a direct file write.
    try { mgr.registry.reloadFromDisk(targetAppId); } catch { /* watcher will reconcile */ }

    return json({
      ok: true, sourceAppId, sourceScope, targetAppId, scope: targetScopeId,
      dest, fileCount, bytes, ported, rewrittenFiles, strippedFields, shadows, warnings,
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
};

function scopeDef(scopes: ScopeDefinition[], id: ScopeId): ScopeDefinition {
  return scopes.find((s) => s.id === id)!;
}

/** Apply the caller's field overrides: string sets, null deletes, undefined
 *  leaves the source's value alone. */
function applyPatch(m: Record<string, unknown>, patch: ManifestPatch | undefined): void {
  if (!patch) return;
  for (const key of ['name', 'icon', 'description', 'version'] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (v === null) delete m[key];
    else m[key] = v;
  }
}

/**
 * Read the live @aura/app-sdk version from the monorepo so cloned user/global
 * apps pin to whatever the local OCI registry actually has. The system scope's
 * appsDir is `<workspaceRoot>/apps`, so packages/ is its sibling.
 */
function readSdkVersion(scopes: ScopeDefinition[]): string {
  const systemDir = scopes.find((s) => s.id === 'system')?.appsDir;
  if (!systemDir) return '0.0.1';
  try {
    const pkg = JSON.parse(readFileSync(join(resolve(systemDir, '..'), 'packages/app-sdk/package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.1';
  } catch {
    return '0.0.1';
  }
}

/** rsync -a with excludes, falling back to cpSync. rsync is preferred because
 *  it handles symlinks, sparse files and large trees more gracefully — and
 *  preserves the 0755 on entrypoint.sh, which a files[]-payload API can't. */
function copyTree(src: string, dst: string, excludes: string[]): void {
  mkdirSync(dst, { recursive: true });
  try {
    execFileSync('rsync', ['-a', ...excludes.map((e) => `--exclude=${e}`), `${src}/`, `${dst}/`],
      { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    const skip = new Set(excludes);
    cpSync(src, dst, {
      recursive: true,
      filter: (from) => !skip.has(from.slice(from.lastIndexOf('/') + 1)),
    });
  }
}

/** Move a directory, falling back to copy+delete when rename(2) can't (cross
 *  device, busy mount). Destination must not exist. */
function moveOrCopy(src: string, dst: string): void {
  try {
    renameSync(src, dst);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EXDEV' || code === 'EBUSY' || code === 'EPERM') {
      cpSync(src, dst, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

/** Every file under `root`, as paths relative to it, skipping excluded dirs. */
function* walkFiles(root: string, excludes: string[]): Generator<string> {
  const skip = new Set(excludes);
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(abs); continue; }
      if (!entry.isFile()) continue;
      yield relative(root, abs);
    }
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
