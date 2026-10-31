/**
 * App identity: `id` (local, reverse-domain, unique per installation) and
 * `originId` (UUID — which logical app artifact this is, across registries
 * and versions).
 *
 *   • A new, independent app gets a new originId (`aura dev new`).
 *   • Updates, publishes and registry moves keep it.
 *   • A clone / fork gets a new id AND a new originId (`aura dev clone`,
 *     Nexus "install as a copy"); `--keep-origin` is the explicit exception
 *     for moving or renaming the same artifact.
 *   • Same originId = a CLAIMED shared identity, never proof: it is a reason
 *     to offer an update, not to perform one silently.
 *
 * This module owns the parts several flows share: the id rewrite of an app
 * tree (clone + Nexus install-as), raw manifest edits that keep the file's
 * key order, and the install-time classification of scenarios A–D.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AppManifestSchema } from '../types/manifest.js';
import {
  AURA_NPMRC, needsNpmrc, portPackageJsonForScope, portToolsForScope,
} from '../scopes/portability.js';
import type { ScopeId } from '../scopes/types.js';

export const APP_ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
export const ORIGIN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newOriginId(): string { return randomUUID(); }

export function isOriginId(v: unknown): v is string {
  return typeof v === 'string' && ORIGIN_ID_PATTERN.test(v);
}

/**
 * Put `key: value` into a manifest object right after `id` (or replace it in
 * place), keeping every other key and its order — manifests are hand-edited
 * files and a reshuffle makes every diff noisy.
 */
export function withKeyAfterId(m: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  if (key in m) { m[key] = value; return m; }
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const [k, v] of Object.entries(m)) {
    out[k] = v;
    if (k === 'id') { out[key] = value; placed = true; }
  }
  if (!placed) out[key] = value;
  return out;
}

/** Read a manifest file's originId without schema parsing (null if none). */
export function readOriginId(manifestPath: string): string | null {
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    return isOriginId(m['originId']) ? m['originId'] : null;
  } catch { return null; }
}

/**
 * Write `originId` into a manifest file (raw JSON edit, key order kept).
 * `mode: 'assign'` only fills a missing one; `'reassign'` replaces it — the
 * explicit, controlled identity change. Returns the id now in the file and
 * whether the file changed.
 */
export function setOriginIdInFile(
  manifestPath: string, opts: { mode: 'assign' | 'reassign'; originId?: string },
): { originId: string; previous: string | null; changed: boolean } {
  const raw = readFileSync(manifestPath, 'utf-8');
  const m = JSON.parse(raw) as Record<string, unknown>;
  const previous = isOriginId(m['originId']) ? m['originId'] : null;
  if (previous && opts.mode === 'assign') return { originId: previous, previous, changed: false };
  const next = opts.originId ?? newOriginId();
  if (!isOriginId(next)) throw new Error(`not a UUID: ${next}`);
  if (next === previous) return { originId: next, previous, changed: false };
  writeFileSync(manifestPath, JSON.stringify(withKeyAfterId(m, 'originId', next), null, 2) + '\n');
  return { originId: next, previous, changed: true };
}

// ─── Rewriting an app tree to a new id ──────────────────────────────────

/** Build artefacts + dep trees never touched by the id sweep. */
export const IDENTITY_SWEEP_EXCLUDES = ['node_modules', '.pnpm-store', '.next', 'dist', '.astro', '.turbo', '.cache', '.git'];
const REWRITE_MAX_BYTES = 512 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;

export interface ManifestPatch {
  name?:        string | null;
  icon?:        string | null;
  description?: string | null;
  version?:     string | null;
}

export interface RewriteIdentityOpts {
  fromId:  string;
  toId:    string;
  /** Scope the tree is going to — ports tools / package.json / .npmrc. */
  scope:   ScopeId;
  /** 'new' = fresh UUID (a clone), 'keep' = leave as is, or an explicit UUID. */
  originId: 'new' | 'keep' | string;
  /** Substitute fromId → toId inside text files. Default true. */
  rewriteIds?:   boolean;
  patch?:        ManifestPatch;
  stripPublish?: boolean;
  stripStore?:   boolean;
  /** @aura/app-sdk version user/global package.json pins to. */
  sdkVersion:    string;
  /** Extra dir names the sweep skips (on top of IDENTITY_SWEEP_EXCLUDES). */
  excludes?:     string[];
}

export type RewriteIdentityResult =
  | {
      ok: true;
      originId: string | null;
      previousOriginId: string | null;
      fileCount: number; bytes: number; ported: boolean;
      rewrittenFiles: string[]; strippedFields: string[]; warnings: string[];
    }
  | { ok: false; error: 'source-has-no-manifest' | 'manifest-invalid'; message: string; issues?: unknown };

/**
 * Give the app tree at `dir` (a staging copy) the identity `toId`: manifest
 * id + originId, `dataProvider.authority`, `critical` strip, tools for the
 * scope, `package.json` name, `.npmrc`, and the source id swept out of the
 * remaining text files. Validates the manifest; writes in place.
 */
export function rewriteAppIdentity(dir: string, o: RewriteIdentityOpts): RewriteIdentityResult {
  const warnings: string[] = [];
  const strippedFields: string[] = [];
  const manifestPath = join(dir, 'app.manifest.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, error: 'source-has-no-manifest', message: `${dir}/app.manifest.json is missing.` };
  }
  let m: Record<string, unknown>;
  try { m = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>; }
  catch (err) { return { ok: false, error: 'source-has-no-manifest', message: `Unparseable manifest: ${(err as Error).message}` }; }

  const previousOriginId = isOriginId(m['originId']) ? m['originId'] : null;
  m['id'] = o.toId;
  const originId = o.originId === 'keep' ? previousOriginId : o.originId === 'new' ? newOriginId() : o.originId;
  if (originId) m = withKeyAfterId(m, 'originId', originId);
  applyPatch(m, o.patch);

  // `dataProvider.authority` is a GLOBAL namespace key — /api/data/<authority>
  // resolves through it. Keeping the source's authority collides with the
  // source, so this rewrite is unconditional.
  const dp = m['dataProvider'] as { authority?: string } | undefined;
  if (dp && typeof dp.authority === 'string') {
    if (dp.authority === o.fromId) dp.authority = o.toId;
    else warnings.push(`dataProvider.authority is '${dp.authority}' (not the source's own id) — left as-is; it may collide with the app that owns it.`);
  }

  // Critical apps cannot be disabled, and apps a user installs themselves
  // should never set it — a user-scope copy of one would be undisablable.
  if (m['critical'] !== undefined) { delete m['critical']; strippedFields.push('critical'); }

  if (o.stripPublish) {
    if (m['publish'] !== undefined) { delete m['publish']; strippedFields.push('publish'); }
  } else if (m['publish'] !== undefined && o.fromId !== o.toId) {
    warnings.push("manifest keeps the source's `publish` block — `aura nexus app publish` would push this copy to the ORIGINAL's repo/registry.");
  }
  if (o.stripStore && m['store'] !== undefined) { delete m['store']; strippedFields.push('store'); }

  const portedTools = portToolsForScope((m['tools'] as string[] | undefined) ?? [], o.scope);
  if (portedTools.length > 0) m['tools'] = portedTools;

  const parsed = AppManifestSchema.safeParse(m);
  if (!parsed.success) {
    return {
      ok: false, error: 'manifest-invalid',
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      issues: parsed.error.issues,
    };
  }
  writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');

  let ported = false;
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      if (pkg['name'] === o.fromId) pkg['name'] = o.toId;
      ported = portPackageJsonForScope(pkg, o.scope, o.sdkVersion).changed;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    } catch (err) {
      warnings.push(`package.json could not be rewritten (${(err as Error).message}); left verbatim.`);
    }
  }
  const npmrcPath = join(dir, '.npmrc');
  if (needsNpmrc(o.scope) && !existsSync(npmrcPath)) writeFileSync(npmrcPath, AURA_NPMRC);

  // Sweep the source id out of the remaining text files (astro header
  // fallbacks, api paths …). The manifest and package.json are owned by the
  // structured rewrites above — sweeping them again would turn the target id
  // into `<target>.copy` when the target id extends the source id.
  const rewrittenFiles: string[] = [];
  const pattern = idRegex(o.fromId);
  const sweep = o.rewriteIds !== false && o.fromId !== o.toId;
  let fileCount = 0;
  let bytes = 0;
  for (const rel of walkFiles(dir, [...IDENTITY_SWEEP_EXCLUDES, ...(o.excludes ?? [])])) {
    const abs = join(dir, rel);
    const size = statSync(abs).size;
    fileCount++;
    bytes += size;
    if (!sweep || rel === 'app.manifest.json' || rel === 'package.json' || size > REWRITE_MAX_BYTES) continue;
    const buf = readFileSync(abs);
    if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue;
    const before = buf.toString('utf-8');
    const after = before.replace(pattern, o.toId);
    if (after === before) continue;
    writeFileSync(abs, after);
    rewrittenFiles.push(rel);
  }
  return { ok: true, originId, previousOriginId, fileCount, bytes, ported, rewrittenFiles, strippedFields, warnings };
}

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
 * Matches the app id as a whole id only: `com.a.b` but not the prefix of
 * `com.a.b.copy` or `com.a.bc`.
 */
export function idRegex(id: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'g');
}

function* walkFiles(root: string, excludes: string[]): Generator<string> {
  const skip = new Set(excludes);
  const stack: string[] = [root];
  while (stack.length > 0) {
    const d = stack.pop()!;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const abs = join(d, entry.name);
      if (entry.isDirectory()) { stack.push(abs); continue; }
      if (entry.isFile()) yield relative(root, abs);
    }
  }
}

// ─── Install-time classification (scenarios A–D) ────────────────────────

/** An app present on this installation. */
export interface InstalledIdentity {
  appId:     string;
  originId:  string | null;
  scope:     ScopeId;
  /** Its Nexus install record, when it came from the store. */
  record?:   {
    ref: string; sourceName?: string; remoteId?: string; originId?: string; detached?: boolean;
  } | null;
}

/** What is being installed and from where. */
export interface IncomingIdentity {
  appId:       string;
  originId:    string | null;
  rawRef:      string;
  sourceName?: string;
}

export type IdentityAction = 'update-existing' | 'install-as' | 'install-copy';

export type IdentityConflictKind =
  /** A: same originId + same id, but installed from another source. */
  | 'switch-source'
  /** B: same id, a different (or unknown) artifact. */
  | 'id-taken'
  /** D: same originId under another local id. */
  | 'same-origin';

export type AppIdentityVerdict =
  | { kind: 'fresh' }
  | { kind: 'update'; target: InstalledIdentity }
  | { kind: 'conflict'; conflict: IdentityConflictKind; existing: InstalledIdentity; choices: IdentityAction[] };

/** Was `rec` installed from the same place `inc` comes from? */
function tracks(rec: InstalledIdentity['record'], inc: IncomingIdentity): boolean {
  if (!rec || rec.detached) return false;
  if (rec.sourceName && inc.sourceName) return rec.sourceName === inc.sourceName;
  return rec.ref === inc.rawRef;
}

/**
 * Decide how an incoming app relates to what is installed. Pure — the caller
 * gathers `installed` (every scope) and acts on the verdict.
 *
 *   update   — the same artifact from the source it was installed from
 *   fresh    — nothing installed shares its id or originId (C)
 *   conflict — the user must choose; never resolved silently:
 *     switch-source (A), id-taken (B), same-origin (D)
 */
export function classifyIdentity(inc: IncomingIdentity, installed: InstalledIdentity[]): AppIdentityVerdict {
  const originOf = (i: InstalledIdentity) => i.originId ?? i.record?.originId ?? null;

  // An app installed under another local id that follows this source (an
  // earlier "install as" / "update existing"): its updates land there.
  const linked = installed.find((i) => i.record?.remoteId === inc.appId && tracks(i.record, inc)
    && (!inc.originId || !originOf(i) || originOf(i) === inc.originId));
  if (linked) return { kind: 'update', target: linked };

  const byId = installed.find((i) => i.appId === inc.appId);
  if (byId) {
    const have = originOf(byId);
    const sameOrigin = !!have && !!inc.originId && have === inc.originId;
    const unknown = !have || !inc.originId;
    if ((sameOrigin || unknown) && tracks(byId.record, inc)) return { kind: 'update', target: byId };
    // A system app can't be replaced; the same artifact into a mutable scope
    // shadows it — the pre-originId behaviour for OS apps from the store.
    if (sameOrigin && byId.scope === 'system') return { kind: 'update', target: byId };
    if (sameOrigin) return { kind: 'conflict', conflict: 'switch-source', existing: byId, choices: ['update-existing', 'install-copy'] };
    // An app without an originId may still be this artifact (installed by
    // hand, or before originIds) — replacing it is allowed, but only when
    // chosen. A known different originId is another app: never replaced.
    return {
      kind: 'conflict', conflict: 'id-taken', existing: byId,
      choices: unknown && byId.scope !== 'system' ? ['install-as', 'update-existing'] : ['install-as'],
    };
  }

  if (inc.originId) {
    const byOrigin = installed.find((i) => originOf(i) === inc.originId);
    if (byOrigin) {
      return { kind: 'conflict', conflict: 'same-origin', existing: byOrigin, choices: ['update-existing', 'install-copy'] };
    }
  }
  return { kind: 'fresh' };
}

/** A free id next to `base`: `<base>.copy`, `<base>.copy2`, … */
export function suggestFreeAppId(base: string, taken: Set<string>): string {
  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? `${base}.copy` : `${base}.copy${n}`;
    if (!taken.has(id)) return id;
  }
  return `${base}.copy${Date.now()}`;
}

/** Every app dir with a manifest under `appsDir`, with its originId. */
export function scanInstalledIdentities(appsDir: string, scope: ScopeId): Array<Omit<InstalledIdentity, 'record'>> {
  let names: string[];
  try { names = readdirSync(appsDir); } catch { return []; }
  const out: Array<Omit<InstalledIdentity, 'record'>> = [];
  for (const name of names) {
    if (!APP_ID_PATTERN.test(name)) continue;           // skips `<id>.tmp.<ts>` staging dirs
    const p = join(appsDir, name, 'app.manifest.json');
    if (!existsSync(p)) continue;
    try {
      const m = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
      if (m['id'] !== name) continue;
      out.push({ appId: name, originId: isOriginId(m['originId']) ? m['originId'] : null, scope });
    } catch { /* unreadable manifest: not an app */ }
  }
  return out;
}
