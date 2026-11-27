// The D68 series slot of a release (Phase 6 stream B step 3; filled by Phase 7b).
//
// A release is `base commit + the system patch series`. The series lives in
// the system patch store (`patches/system`, a git repository; layout.mjs) or,
// for install-time patches and tests, in a plain directory with the same
// shape. This module reads it, checks it and applies it to the staging tree
// with THE patch library: `packages/core/src/patches/{seriesFile,digest,
// validate,apply}.ts`, run directly from this trusted copy's source with
// Node's type stripping (those four modules import only node builtins and
// types). There is no second parser, digest or validator here (D36).
//
//   empty series (no store, or nothing ever activated)   → EMPTY_SERIES_DIGEST
//   a series                                             → seriesDigest({ target, base: <built commit>, patches })
//
// The digest of a built series names the commit it was built on (a series
// re-based onto a new release is a new identity, D68), not the base written
// in the file: `declaredBase` keeps that.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const EMPTY_SERIES = Object.freeze({ base: null, order: Object.freeze([]) });
/** Phase 6's digest of "no series": a constant (sha256 over canonical JSON of the empty slot). */
export const EMPTY_SERIES_DIGEST = `sha256:${createHash('sha256').update(JSON.stringify({ v: 1, base: null, order: [] })).digest('hex')}`;

/** The store's ref of the revision the running release carries (moved after an activation). */
export const ACTIVE_REF = 'refs/aura/active';
/** `refs/aura/approved/<n>`: revisions an approval or the operator authorized. */
export const APPROVED_REF_PREFIX = 'refs/aura/approved/';

export class SeriesSlotError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

const LIB = new URL('../../packages/core/src/patches/', import.meta.url);
let lib = null;
/** The patch library from this copy's source (type stripping; Node >= 22.18). */
export async function patchLib() {
  if (lib) return lib;
  const [file, digest, validate, apply] = await Promise.all(
    ['seriesFile.ts', 'digest.ts', 'validate.ts', 'apply.ts'].map((f) => import(new URL(f, LIB).href)),
  );
  lib = { ...file, ...digest, ...validate, ...apply };
  return lib;
}

const GIT_ENV = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });
function git(dir, args, { env, input } = {}) {
  const r = spawnSync('git', ['-c', `safe.directory=${dir}`, '-C', dir, ...args], { env: env ?? GIT_ENV(), input, maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status ?? 1, out: r.stdout?.toString() ?? '', err: r.stderr?.toString() ?? '' };
}
const gitOk = (dir, args, opts) => {
  const r = git(dir, args, opts);
  if (r.code) throw new SeriesSlotError('series-git', `git ${args[0]} failed: ${r.err.trim().split('\n').slice(-2).join(' ')}`);
  return r.out;
};

/** The store's revision a ref names, or null. */
export function storeRev(store, ref = ACTIVE_REF) {
  if (!store || !existsSync(join(store, '.git')) && !existsSync(join(store, 'HEAD'))) return null;
  const r = git(store, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]);
  return r.code ? null : r.out.trim();
}

/**
 * Reads a series: `{ dir }` (a directory: aura-patches.yaml + patches/), or
 * `{ store, rev }` (the store at a revision). Every patch is read by content,
 * checked against its recorded sha256 and validated for the system target
 * (refused content never reaches the tree). Returns
 * { series, patches: [{ file, subject, sha256, enabled, content, validation }], rev, flags }.
 */
export async function readSeriesInput(input) {
  const L = await patchLib();
  let text;
  let read;
  let rev = null;
  if (input?.dir) {
    const f = join(input.dir, L.SERIES_FILE);
    if (!existsSync(f)) throw new SeriesSlotError('series-missing', `${f} does not exist`);
    text = readFileSync(f, 'utf8');
    read = (file) => { try { return readFileSync(join(input.dir, file), 'utf8'); } catch { return null; } };
  } else if (input?.store && input.rev) {
    rev = gitOk(input.store, ['rev-parse', '--verify', `${input.rev}^{commit}`]).trim();
    text = gitOk(input.store, ['show', `${rev}:${L.SERIES_FILE}`]);
    read = (file) => { const r = git(input.store, ['show', `${rev}:${file}`]); return r.code ? null : r.out; };
  } else {
    throw new SeriesSlotError('usage', 'a series is { dir } or { store, rev }');
  }
  let series;
  try { series = L.parseSeriesJson(text); } catch (e) { throw new SeriesSlotError('series-invalid', e.message); }
  if (series.target.kind !== 'system') throw new SeriesSlotError('series-invalid', `the series targets ${series.target.kind} ${series.target.appId ?? ''}, not the system`);
  const refused = [];
  const flags = [];
  const patches = series.patches.map((p) => {
    const content = read(p.file);
    if (content === null) throw new SeriesSlotError('series-invalid', `${p.file} is listed in ${L.SERIES_FILE} but missing`);
    const sha256 = L.sha256Hex(content);
    if (p.sha256 && p.sha256 !== sha256) throw new SeriesSlotError('series-invalid', `${p.file} does not match its sha256 in ${L.SERIES_FILE}`);
    const validation = L.validatePatch(content, { target: { kind: 'system' } });
    if (p.enabled !== false) {
      for (const f of validation.refused) refused.push(`${p.file}: ${f.message}`);
      for (const f of validation.flags) flags.push({ file: p.file, code: f.code, message: f.message });
    }
    return { file: p.file, subject: p.subject, sha256, enabled: p.enabled !== false, content, validation };
  });
  if (refused.length) throw new SeriesSlotError('series-refused', `refused patch content: ${refused.join('; ')}`, { refused });
  return { series, patches, rev, flags };
}

/**
 * The series of a build: `requested` ({ dir } | { store, rev } | { none: true }),
 * else the store's active revision, else none. Returns null for no series.
 */
export async function seriesForBuild({ store, requested = null } = {}) {
  if (requested?.none) return null;
  if (requested) return readSeriesInput(requested);
  const rev = storeRev(store);
  return rev ? readSeriesInput({ store, rev }) : null;
}

/** Digest and binding fields of a series built on `commit` (the one digest function: core patches/digest.ts). */
export async function seriesIdentity(read, commit) {
  const L = await patchLib();
  const binding = L.patchBinding({ target: { kind: 'system' }, base: { commit }, patches: read.patches }, read.rev ?? '');
  return { digest: `sha256:${binding.seriesDigest}`, binding };
}

/**
 * Applies the enabled patches to a staging tree that holds `commit` (a git
 * archive extraction): a throwaway git dir borrowing the mirror's objects
 * (for three-way merges onto a newer base), `git am --3way` each patch, then
 * the git dir is removed (no .git in a release). Returns the ApplyResult.
 */
export async function applyToStaging({ staging, mirror, commit, patches }) {
  const L = await patchLib();
  const env = { ...GIT_ENV(), GIT_AUTHOR_NAME: 'Aura', GIT_AUTHOR_EMAIL: 'aura@aura.local', GIT_COMMITTER_NAME: 'Aura', GIT_COMMITTER_EMAIL: 'aura@aura.local' };
  const gd = join(staging, '.git');
  try {
    gitOk(staging, ['init', '-q'], { env });
    mkdirSync(join(gd, 'objects', 'info'), { recursive: true });
    writeFileSync(join(gd, 'objects', 'info', 'alternates'), `${join(mirror, 'objects')}\n`);
    gitOk(staging, ['update-ref', 'HEAD', commit], { env });
    gitOk(staging, ['reset', '-q'], { env });
    return L.amApply(staging, patches, { gitArgs: ['-c', `safe.directory=${staging}`], env });
  } finally {
    rmSync(gd, { recursive: true, force: true });
  }
}

/** The component of a source path, from the same enumeration as release.json components.source. */
export function componentOf(path, sourceComps) {
  const parts = path.split('/');
  if ((parts[0] === 'packages' || parts[0] === 'apps') && parts.length > 2) {
    const c = sourceComps.find((x) => x.path === `${parts[0]}/${parts[1]}`);
    if (c) {
      const out = { component: c.name, kind: c.kind };
      // The core sector map (packages/core/AGENTS.md) names modules under packages/core/src/<module>/.
      if (c.path === 'packages/core' && parts[2] === 'src' && parts.length > 4) out.module = parts[3];
      return out;
    }
    return { component: `${parts[0]}/${parts[1]}`, kind: parts[0] === 'apps' ? 'app' : 'package', unknown: true };
  }
  if (parts[0] === 'os') return { component: 'os', kind: 'os' };
  return { component: '_root', kind: 'root' };
}

/** The touched components of a series, merged (one entry per component, modules listed). */
export async function touchedComponents(patches, sourceComps) {
  const L = await patchLib();
  const byName = new Map();
  for (const p of L.touchedPaths(patches.filter((x) => x.enabled))) {
    const c = componentOf(p, sourceComps);
    const e = byName.get(c.component) ?? { component: c.component, kind: c.kind, paths: 0, modules: [] };
    e.paths += 1;
    if (c.module && !e.modules.includes(c.module)) e.modules.push(c.module);
    if (c.unknown) e.unknown = true;
    byName.set(c.component, e);
  }
  return [...byName.values()].sort((a, b) => a.component.localeCompare(b.component));
}

/**
 * Install-time patches (Phase 7b I): the authorized series becomes the system
 * patch store, with its history: a git source keeps its commits up to the
 * pinned ref; a directory becomes one commit naming the operator's import.
 * Refuses an existing store (a fresh install has none). Returns the revision.
 */
export function importStore({ store, dir, source, by }) {
  if (existsSync(store) && readdirSync(store).length) throw new SeriesSlotError('store-exists', `${store} is not empty: install-time patches go into a fresh install`);
  mkdirSync(store, { recursive: true, mode: 0o750 });
  const env = { ...GIT_ENV(), GIT_AUTHOR_NAME: 'AuraOS installer', GIT_AUTHOR_EMAIL: 'installer@aura.local', GIT_COMMITTER_NAME: 'AuraOS installer', GIT_COMMITTER_EMAIL: 'installer@aura.local' };
  if (existsSync(join(dir, '.git'))) {
    const r = spawnSync('git', ['clone', '-q', '--no-hardlinks', dir, store], { env });
    if (r.status) throw new SeriesSlotError('series-git', `importing the series history failed: ${String(r.stderr).trim()}`);
    gitOk(store, ['checkout', '-q', '-B', 'main', gitOk(dir, ['rev-parse', 'HEAD']).trim()], { env });
    gitOk(store, ['remote', 'remove', 'origin'], { env });
  } else {
    gitOk(store, ['init', '-q', '-b', 'main'], { env });
    mkdirSync(join(store, 'patches'), { recursive: true });
    spawnSync('cp', ['-p', join(dir, 'aura-patches.yaml'), store]);
    spawnSync('sh', ['-c', 'cp -p "$1"/patches/*.patch "$2"/patches/ 2>/dev/null || true', 'sh', dir, store]);
    gitOk(store, ['add', '-A', '--', 'aura-patches.yaml', 'patches'], { env });
    gitOk(store, ['commit', '-q', '-m', `install: imported from ${source} by the operator\n\n${by}`], { env });
  }
  return gitOk(store, ['rev-parse', 'HEAD']).trim();
}

/** After the first patched release built: the revision is approved (by the operator) and active. */
export function markInstalled({ store, rev }) {
  gitOk(store, ['update-ref', `${APPROVED_REF_PREFIX}1`, rev]);
  gitOk(store, ['update-ref', ACTIVE_REF, rev]);
}
