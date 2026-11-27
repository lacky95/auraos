/**
 * The system patch engine (Phase 7b, D68): `aura system patch start | save |
 * status | diff | disable | enable | activate`, on the Phase 6 release builder.
 *
 * One shared library (`patches/`), a separate engine: this module owns the
 * system patch STORE and the system WORKSPACES, and drives the builder. It
 * does not apply patches to a release itself: the builder's series step does
 * (`os/release/series-slot.mjs`, the same library), from the trusted copy of
 * the running release, in its own process.
 *
 *   <data>/patches/system/                   the store: a git repository (git history = the first registry)
 *     aura-patches.yaml, patches/*.patch     the series (v2, target system), one commit per revision
 *     refs/aura/active                       the revision the running release carries
 *     refs/aura/approved/<n>                 revisions an owner approval or the operator authorized
 *   <data>/aura/workspaces/<userId>/system/<n>/   a writable checkout: release commit + the active series (the
 *                                            app workspaces' layout, installation `system`: nexus workspaceSubpath)
 *   <data>/aura/release/needs-repair.json    the last patch that failed to apply on an update (U)
 *
 * Plain data in and out; the shell routes authorize (owner only, `fresh` for
 * activate and enable) and audit; nothing here reads a session.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  applySeries, exportPatches, sha256Hex, gitError, loadSeries, patchBinding, readSeries, safeDirectoryArgs, saveSeries, seriesDigest,
  validatePatch, type ApplyResult, type ExportedPatch, type PatchBinding, type Series,
} from '../patches/index.js';
import { SESSION_HOST_APP_IDS } from '../system/systemApps.js';

export const SYSTEM_STORE_DIR = 'patches/system';
/** The installation slot of system workspaces in the per-user workspace layout (`aura/workspaces/<userId>/system/<n>`). */
export const SYSTEM_INSTALLATION = 'system';
export const NEEDS_REPAIR_FILE = 'aura/release/needs-repair.json';
export const ACTIVE_REF = 'refs/aura/active';
export const APPROVED_REF_PREFIX = 'refs/aura/approved/';
const MARKER = 'aura-system-workspace.json';

/** Errors carry a stable code (routes map them to HTTP answers). */
export class SystemPatchError extends Error {
  constructor(public readonly code: string, message: string, public readonly detail?: Record<string, unknown>) { super(message); }
}

export const storeDir = (dataDir: string): string => join(dataDir, SYSTEM_STORE_DIR);

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
function git(cwd: string, args: string[], timeout = 120_000): string {
  return execFileSync('git', [...safeDirectoryArgs(cwd), '-C', cwd, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout, env: { ...GIT_ENV, AURA_DATA_DIR: process.env['AURA_DATA_DIR'] }, maxBuffer: 64 * 1024 * 1024,
  }).toString();
}
const tryGit = (cwd: string, args: string[]): string | null => { try { return git(cwd, args).trim() || null; } catch { return null; } };

// ─── the store ──────────────────────────────────────────────────────────────

/** The revision a ref names in the store, or null. */
export function storeRef(dataDir: string, ref: string): string | null {
  const s = storeDir(dataDir);
  if (!existsSync(join(s, '.git'))) return null;
  return tryGit(s, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]);
}

/** A revision of the store, verified to exist (a full hash). */
export function resolveRev(dataDir: string, rev = 'HEAD'): string {
  if (!/^[0-9A-Za-z/_.^~-]{1,200}$/.test(rev) || rev.startsWith('-')) throw new SystemPatchError('bad-rev', `not a revision: ${rev}`);
  const r = storeRef(dataDir, rev);
  if (!r) throw new SystemPatchError('no-series', rev === 'HEAD' ? 'no system patch has been saved yet (aura system patch save)' : `no revision ${rev} in the system patch store`);
  return r;
}

export interface SeriesView {
  rev: string;
  digest: string;
  base: Series['base'];
  patches: Array<{ index: number; file: string; subject: string; sha256: string; enabled: boolean; flags: string[] }>;
}

/** The series at a store revision, with its patches' flags (the approval shows them). */
export function seriesView(dataDir: string, rev = 'HEAD'): SeriesView {
  const full = resolveRev(dataDir, rev);
  const loaded = loadSeries(storeDir(dataDir), full);
  if (!loaded) throw new SystemPatchError('no-series', `revision ${full.slice(0, 12)} holds no series`);
  if (loaded.series.target.kind !== 'system') throw new SystemPatchError('bad-series', 'the store holds a series that does not target the system');
  return {
    rev: full, digest: loaded.digest, base: loaded.series.base,
    patches: loaded.patches.map((p, index) => ({
      index, file: p.file, subject: p.subject, sha256: p.sha256, enabled: p.enabled,
      flags: validatePatch(p.content, { target: { kind: 'system' } }).flags.map((f) => f.message),
    })),
  };
}

/** The exact change of a revision: its enabled patch files, in order (what an approval shows). */
export function seriesDiff(dataDir: string, rev = 'HEAD'): string {
  const full = resolveRev(dataDir, rev);
  const loaded = loadSeries(storeDir(dataDir), full);
  if (!loaded) return '';
  return loaded.patches.filter((p) => p.enabled).map((p) => p.content).join('\n');
}

/** Revisions, newest first: the registry (git history). */
export function seriesLog(dataDir: string, limit = 20): Array<{ rev: string; at: string; subject: string }> {
  const s = storeDir(dataDir);
  if (!existsSync(join(s, '.git'))) return [];
  const out = tryGit(s, ['log', `-${limit}`, '--format=%H%x09%cI%x09%s']) ?? '';
  return out.split('\n').filter(Boolean).map((l) => { const [rev, at, subject] = l.split('\t'); return { rev: rev!, at: at!, subject: subject ?? '' }; });
}

/** The approved refs, by number. */
export function approvedRevs(dataDir: string): Array<{ n: number; rev: string }> {
  const s = storeDir(dataDir);
  if (!existsSync(join(s, '.git'))) return [];
  const out = tryGit(s, ['for-each-ref', '--format=%(refname) %(objectname)', APPROVED_REF_PREFIX]) ?? '';
  return out.split('\n').filter(Boolean).map((l) => {
    const [ref, rev] = l.split(' ');
    return { n: Number(ref!.slice(APPROVED_REF_PREFIX.length)), rev: rev! };
  }).filter((x) => Number.isInteger(x.n)).sort((a, b) => a.n - b.n);
}

/** Record a revision as approved (owner approval consumed, or operator authorization at install). */
export function markApproved(dataDir: string, rev: string): number {
  const n = (approvedRevs(dataDir).pop()?.n ?? 0) + 1;
  git(storeDir(dataDir), ['update-ref', `${APPROVED_REF_PREFIX}${n}`, rev]);
  return n;
}

/** Move `refs/aura/active` (only after the release carrying `rev` accepts writes). */
export function markActive(dataDir: string, rev: string | null): void {
  const s = storeDir(dataDir);
  if (rev) git(s, ['update-ref', ACTIVE_REF, rev]);
  else tryGit(s, ['update-ref', '-d', ACTIVE_REF]);
}

function ensureStore(dataDir: string): string {
  const s = storeDir(dataDir);
  mkdirSync(s, { recursive: true });
  try { chmodSync(s, 0o750); } catch { /* best effort */ }
  return s;
}

// ─── workspaces ─────────────────────────────────────────────────────────────

export interface SystemWorkspaceMarker {
  kind: 'system';
  userId: string;
  n: number;
  baseCommit: string;
  release: string | null;
  version: string | null;
  /** The store revision applied when it was made (null: no series yet). */
  seriesRev: string | null;
}

export function readWorkspaceMarker(ws: string): SystemWorkspaceMarker | null {
  try { return JSON.parse(readFileSync(join(ws, '.git', MARKER), 'utf8')) as SystemWorkspaceMarker; } catch { return null; }
}

/** A user's system workspaces under `root` (`<data>/aura/workspaces/<userId>/system`), oldest first. */
export function listWorkspaces(root: string): Array<{ n: number; path: string; marker: SystemWorkspaceMarker | null }> {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((x) => /^\d+$/.test(x)).map(Number).sort((a, b) => a - b)
    .map((n) => ({ n, path: join(root, String(n)), marker: readWorkspaceMarker(join(root, String(n))) }));
}

export interface StartInput {
  dataDir: string;
  userId: string;
  /** This user's system workspace dir (`<data>/aura/workspaces/<userId>/system`; the shell computes it with nexus workspaceSubpath). */
  root: string;
  /** The bare release mirror (layout: aura/release/mirror.git). */
  mirror: string;
  /** The release to start from: the running one, or `--base <release>` for a repair. */
  base: { commit: string; release: string | null; version: string | null };
  /** A fresh workspace even when one exists. */
  fresh?: boolean;
}

export interface StartResult { path: string; n: number; created: boolean; marker: SystemWorkspaceMarker; apply: ApplyResult | null }

/**
 * The caller's newest workspace on that base, or a new one: a clone of the
 * mirror at the release commit (never /workspace), the ACTIVE series applied
 * on top (a conflict stays in the tree for repair). Nothing here runs code
 * of the checkout.
 */
export function startWorkspace(i: StartInput): StartResult {
  const existing = listWorkspaces(i.root).reverse().find((w) => w.marker && w.marker.baseCommit === i.base.commit);
  if (existing && !i.fresh) return { path: existing.path, n: existing.n, created: false, marker: existing.marker!, apply: null };
  if (!existsSync(join(i.mirror, 'HEAD'))) throw new SystemPatchError('no-mirror', 'the release mirror is missing: this install does not run from a release');
  const n = (listWorkspaces(i.root).pop()?.n ?? 0) + 1;
  if (n > 9999) throw new SystemPatchError('too-many-workspaces', 'remove old system workspaces first');
  const ws = join(i.root, String(n));
  mkdirSync(ws, { recursive: true });
  try {
    execFileSync('git', ['clone', '-q', '--no-checkout', i.mirror, ws], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000, env: GIT_ENV });
    git(ws, ['checkout', '-q', '-B', 'patches', i.base.commit]);
  } catch (err) {
    throw new SystemPatchError('checkout-failed', `could not check out ${i.base.commit.slice(0, 12)}: ${gitError(err)}`);
  }
  const activeRev = storeRef(i.dataDir, ACTIVE_REF);
  const marker: SystemWorkspaceMarker = {
    kind: 'system', userId: i.userId, n, baseCommit: i.base.commit, release: i.base.release, version: i.base.version, seriesRev: activeRev,
  };
  writeFileSync(join(ws, '.git', MARKER), `${JSON.stringify(marker, null, 2)}\n`);
  let apply: ApplyResult | null = null;
  if (activeRev) {
    const loaded = loadSeries(storeDir(i.dataDir), activeRev);
    if (loaded?.patches.some((p) => p.enabled)) apply = applySeries(ws, loaded.patches, { keepConflict: true, target: { kind: 'system' } });
  }
  return { path: ws, n, created: true, marker, apply };
}

// ─── save, disable, enable ──────────────────────────────────────────────────

export interface SaveResult { rev: string; changed: boolean; digest: string; patches: number }

/**
 * Save a workspace's commits (base..HEAD) as a new series revision. Each
 * patch is validated (refused content, the trust anchor, is refused here,
 * at save). Patches the head series has DISABLED are kept at the end,
 * disabled (a workspace never applies them, so it cannot export them).
 */
export function saveWorkspace(input: { dataDir: string; workspace: string; message: string }): SaveResult {
  const m = readWorkspaceMarker(input.workspace);
  if (!m || m.kind !== 'system') throw new SystemPatchError('not-a-workspace', `${input.workspace} is not a system patch workspace`);
  if (existsSync(join(input.workspace, '.git', 'rebase-apply'))) {
    throw new SystemPatchError('in-progress', 'a patch is still being applied in the workspace: resolve it (git am --continue) or abort it first');
  }
  let patches: ExportedPatch[];
  try { patches = exportPatches(input.workspace, m.baseCommit); } catch (err) { throw new SystemPatchError('export-failed', (err as Error).message); }
  const store = ensureStore(input.dataDir);
  const head = existsSync(join(store, '.git')) ? readSeries(store, 'HEAD') : null;
  if (head) {
    const loaded = loadSeries(store, resolveRev(input.dataDir, 'HEAD'));
    for (const p of loaded?.patches ?? []) {
      if (p.enabled || patches.some((x) => sha256Hex(x.content) === p.sha256)) continue;
      // Kept by content; a name the workspace's export now uses gets a distinct one.
      const file = patches.some((x) => x.file === p.file) ? `patches/disabled-${p.sha256.slice(0, 8)}-${p.file.slice('patches/'.length)}` : p.file;
      patches.push({ file, subject: p.subject, content: p.content, enabled: false });
    }
  }
  return save(input.dataDir, { commit: m.baseCommit, release: m.release ?? undefined }, patches, input.message);
}

function save(dataDir: string, base: { commit: string; release?: string }, patches: ExportedPatch[], message: string): SaveResult {
  try {
    const r = saveSeries(storeDir(dataDir), { target: { kind: 'system' }, base: { commit: base.commit, ...(base.release ? { release: base.release } : {}) }, patches, message });
    const digest = seriesDigest({ target: { kind: 'system' }, base: r.series.base, patches: r.series.patches.map((p) => ({ sha256: p.sha256!, enabled: p.enabled })) });
    return { rev: r.commit, changed: r.changed, digest, patches: r.series.patches.length };
  } catch (err) {
    throw new SystemPatchError('refused', (err as Error).message);
  }
}

/** A new revision with one patch's flag changed (by 1-based number, file name or sha256 prefix). */
export function setPatchEnabled(input: { dataDir: string; patch: string; enabled: boolean; message: string }): SaveResult & { file: string } {
  const head = resolveRev(input.dataDir, 'HEAD');
  const loaded = loadSeries(storeDir(input.dataDir), head)!;
  const idx = findPatch(loaded.patches, input.patch);
  const target = loaded.patches[idx]!;
  if (target.enabled === input.enabled) throw new SystemPatchError('unchanged', `${target.file} is already ${input.enabled ? 'enabled' : 'disabled'}`);
  const patches = loaded.patches.map((p, i) => ({ file: p.file, subject: p.subject, content: p.content, enabled: i === idx ? input.enabled : p.enabled }));
  return { ...save(input.dataDir, loaded.series.base, patches, input.message), file: target.file };
}

function findPatch(patches: Array<{ file: string; sha256: string }>, key: string): number {
  const n = /^\d+$/.test(key) ? Number(key) - 1 : -1;
  const idx = n >= 0 && n < patches.length ? n
    : patches.findIndex((p) => p.file === key || p.file === `patches/${key}` || (key.length >= 7 && p.sha256.startsWith(key)));
  if (idx < 0) throw new SystemPatchError('no-patch', `no patch ${key} in the series`);
  return idx;
}

// ─── approval binding, D35, display ─────────────────────────────────────────

export interface TouchedComponent { component: string; kind: string; modules?: string[]; built?: boolean | null; deployed?: boolean; paths?: number }

/** What the builder's validation run reports about a series (release.json `series`). */
export interface ValidatedSeries {
  digest: string;
  rev: string | null;
  base: { commit: string; version: string | null } | null;
  order: Array<{ file: string; sha256: string; subject: string }>;
  disabled?: Array<{ file: string; sha256: string; subject: string }>;
  touched?: TouchedComponent[];
  rebuildsImage?: boolean;
  binding?: PatchBinding;
  flags?: Array<{ file: string; code: string; message: string }>;
}

/**
 * The `system.patch.activate` approval binding (D68, D73): the full
 * PatchBinding (target, base commit = the release it builds on, revision,
 * digest, order, disabled, composition) plus the release identity and the
 * components the series touches. Recomputed from the STORE at `rev` and
 * compared with what the builder validated: any difference refuses.
 */
export interface SystemPatchBinding {
  releaseId: string;
  commit: string;
  version: string | null;
  provenance: string;
  composition: string;
  series: PatchBinding;
  components: TouchedComponent[];
  rebuildsImage: boolean;
}

export function systemPatchBinding(input: { dataDir: string; rev: string; validated: { id: string; commit: string; version: string | null; provenance: string; composition: string; series: ValidatedSeries } }): SystemPatchBinding {
  const loaded = loadSeries(storeDir(input.dataDir), resolveRev(input.dataDir, input.rev));
  if (!loaded) throw new SystemPatchError('no-series', `revision ${input.rev} holds no series`);
  const v = input.validated;
  const binding = patchBinding({ target: { kind: 'system' }, base: { commit: v.commit }, patches: loaded.patches }, input.rev, { composition: v.composition });
  if (`sha256:${binding.seriesDigest}` !== v.series.digest || v.series.rev !== input.rev) {
    throw new SystemPatchError('binding-mismatch', 'the validated build is not of this revision: validate again');
  }
  return {
    releaseId: v.id, commit: v.commit, version: v.version, provenance: v.provenance, composition: v.composition,
    series: binding, components: (v.series.touched ?? []).map(({ component, kind, modules, built, deployed }) => ({ component, kind, ...(modules?.length ? { modules } : {}), built: built ?? null, deployed: deployed ?? true })),
    rebuildsImage: v.series.rebuildsImage === true,
  };
}

/** D35: the activation ends sessions when it touches a session host (from the system-app constant) or the images. */
export function endsSessions(b: Pick<SystemPatchBinding, 'components' | 'rebuildsImage'>): string[] {
  const out = b.components.filter((c) => SESSION_HOST_APP_IDS.has(c.component)).map((c) => c.component);
  return b.rebuildsImage ? [...out, 'the AuraOS images'] : out;
}

/** The approval dialog's lines (server-built from the binding and the store). */
export function approvalDetails(b: SystemPatchBinding, view: SeriesView): string[] {
  const enabled = view.patches.filter((p) => p.enabled);
  return [
    `Base release: ${b.version ?? 'main'} (${b.commit.slice(0, 12)})`,
    `Series revision: ${b.series.seriesRev.slice(0, 12)}, digest ${b.series.seriesDigest.slice(0, 12)}`,
    ...enabled.map((p, i) => `Patch ${i + 1}: ${p.subject} (${p.file})${p.flags.length ? ` [${p.flags.join('; ')}]` : ''}`),
    ...view.patches.filter((p) => !p.enabled).map((p) => `Disabled: ${p.subject} (${p.file})`),
    `Components: ${b.components.map((c) => `${c.component}${c.modules?.length ? ` (${c.modules.join(', ')})` : ''}${c.deployed === false ? ' (not deployed in this composition)' : ''}`).join(', ') || 'none'}`,
    `Composition: ${b.composition}`,
    `After activation: AuraOS ${b.version ?? 'main'}, locally modified (${enabled.length} system patch${enabled.length === 1 ? '' : 'es'}, series ${b.series.seriesDigest.slice(0, 7)}), based on ${b.provenance === 'locally-modified' && b.version ? `signed ${b.version}` : 'an unsigned revision'}`,
  ];
}

// ─── needs repair, update policy (U, D71) ───────────────────────────────────

export interface NeedsRepair {
  /** The release the series failed to apply to. */
  release: string | null;
  commit: string;
  rev: string | null;
  patch: { file: string; subject: string; sha256: string | null };
  index: number;
  reason: 'conflict' | 'validation' | 'build' | 'check';
  conflicts: string[];
  message: string;
  at: string;
  /** Set when the update went ahead without the patch (the revision that disabled it). */
  disabledIn?: string;
  securityUpdate?: boolean;
}

export function readNeedsRepair(dataDir: string): NeedsRepair | null {
  try { return JSON.parse(readFileSync(join(dataDir, NEEDS_REPAIR_FILE), 'utf8')) as NeedsRepair; } catch { return null; }
}

export function writeNeedsRepair(dataDir: string, r: NeedsRepair | null): void {
  const f = join(dataDir, NEEDS_REPAIR_FILE);
  if (!r) { try { renameSync(f, `${f}.cleared`); } catch { /* none */ } return; }
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(`${f}.tmp`, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o640 });
  renameSync(`${f}.tmp`, f);
}

export type SecurityUpdatePolicy = 'follow-signed' | 'hold';

export interface UpdatePlan {
  /** What happens by default. */
  action: 'update-with-series' | 'update-without-failing' | 'choose';
  /** The choices the owner gets (the dialog and the CLI); the first is the default. */
  choices: Array<'update-without-patch' | 'hold-update'>;
  /** The record of a hold under the local override (D71), when the owner holds a security update. */
  holdIsOverride: boolean;
  notify: boolean;
}

/**
 * D68/D71: an update with an active series. All patches apply → the update
 * carries the re-based series. A patch fails → needs repair, and:
 *   ordinary update: "Update without this patch" (default) or "Hold update";
 *   SIGNED security update, policy follow-signed: no hold offered, the update
 *     proceeds without the failing patch (the owner still approves the update);
 *   SIGNED security update, policy hold (an explicit, audited local override):
 *     hold is offered and, when chosen, recorded as held by local policy.
 * An unsigned (`main`) revision's securityUpdate flag is never honoured.
 */
export function planUpdate(i: { failed: boolean; securityUpdate: boolean; signed: boolean; policy: SecurityUpdatePolicy }): UpdatePlan {
  if (!i.failed) return { action: 'update-with-series', choices: [], holdIsOverride: false, notify: false };
  const security = i.securityUpdate && i.signed;
  if (security && i.policy === 'follow-signed') return { action: 'update-without-failing', choices: ['update-without-patch'], holdIsOverride: false, notify: true };
  return { action: 'choose', choices: ['update-without-patch', 'hold-update'], holdIsOverride: security, notify: true };
}

/**
 * "Update without this patch": a new revision with the failing patch
 * disabled (it stays in the store, marked needs repair). Returns the revision
 * the update builds with.
 */
export function disableForUpdate(dataDir: string, repair: NeedsRepair, by: string): SaveResult & { file: string } {
  const r = setPatchEnabled({
    dataDir, patch: repair.patch.sha256 ?? repair.patch.file, enabled: false,
    message: `disable ${repair.patch.file}: needs repair on ${repair.release ?? repair.commit.slice(0, 12)} (${by})`,
  });
  writeNeedsRepair(dataDir, { ...repair, disabledIn: r.rev });
  return r;
}

/** The notification of a needs-repair record (same pattern as `aura dev patch`'s). */
export function needsRepairNotice(r: NeedsRepair): { title: string; body: string } {
  return {
    title: `System patch needs repair: ${r.patch.subject}`,
    body: `${r.patch.file} does not apply to ${r.release ?? r.commit.slice(0, 12)}${r.conflicts.length ? ` (conflicts in ${r.conflicts.join(', ')})` : ''}. `
      + `${r.disabledIn ? 'The update ran without it. ' : ''}Repair: aura system patch start --base ${r.release ?? r.commit}, fix, save, activate.`,
  };
}

// ─── the builder (os/release/builder.mjs of the running release, its own process) ─

export interface BuilderInput {
  /** The running release's root (its os/release/builder.mjs and os/release-keys are the trusted side). */
  auraRoot: string;
  dataDir: string;
  dataVolume: string;
  /** source.json: where releases come from. */
  fetchFrom: string;
  channel: 'signed' | 'main';
  /** The release tag (signed) or commit (main) the series builds on. */
  ref: string;
  commit: string;
  composition: string;
  rev: string;
  jobId: string;
  validateOnly?: boolean;
  imageChangeApproved?: boolean;
  expectSeriesDigest?: string;
  infraFile?: string;
}

/** The builder's argv (verify after 6: U's updater passes the same series flags). */
export function builderArgs(i: BuilderInput): string[] {
  return [
    join(i.auraRoot, 'os/release/builder.mjs'), 'build',
    '--data-root', i.dataDir, '--data-volume', i.dataVolume, '--fetch-from', i.fetchFrom,
    '--channel', i.channel, '--ref', i.ref, '--expect-commit', i.commit,
    ...(i.channel === 'signed' ? ['--keys', join(i.auraRoot, 'os/release-keys')] : []),
    '--composition', i.composition, '--job', i.jobId,
    '--series-store', storeDir(i.dataDir), '--series-rev', i.rev,
    ...(i.validateOnly ? ['--validate-only'] : []),
    ...(i.imageChangeApproved ? ['--image-change-approved'] : []),
    ...(i.expectSeriesDigest ? ['--expect-series-digest', i.expectSeriesDigest] : []),
    ...(i.infraFile ? ['--infra', i.infraFile] : []),
  ];
}

export interface BuilderRun { code: number; result: Record<string, unknown> | null }

/** Runs the builder to the end (its job file under aura/release/jobs records every step). */
export function runBuilder(i: BuilderInput, opts: { node?: string; log?: (line: string) => void } = {}): Promise<BuilderRun> {
  return new Promise((resolve) => {
    const child = spawn(opts.node ?? process.execPath, builderArgs(i), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l && opts.log) opts.log(l); });
    child.on('error', () => resolve({ code: 127, result: null }));
    child.on('close', (code) => {
      let result: Record<string, unknown> | null = null;
      try { result = JSON.parse(out) as Record<string, unknown>; } catch { /* none */ }
      resolve({ code: code ?? 1, result });
    });
  });
}

/**
 * U's hook (verify after 6: SelfUpdater's release update calls it when the
 * builder answers `needs-repair`): records the needs-repair state, decides
 * with `planUpdate`, and for a signed security update under `follow-signed`
 * disables the failing patch right away (the update then rebuilds with
 * `rev`). For the other cases the owner chooses; "Update without this patch"
 * is `disableForUpdate`, "Hold update" changes nothing.
 */
export function onUpdateConflict(i: {
  dataDir: string;
  /** The builder's `repair` (BuildError.repair / its JSON answer). */
  repair: Omit<NeedsRepair, 'at' | 'reason'> & { reason?: NeedsRepair['reason'] };
  securityUpdate: boolean;
  signed: boolean;
  policy: SecurityUpdatePolicy;
  by: string;
}): { plan: UpdatePlan; record: NeedsRepair; rev: string | null; notice: { title: string; body: string } } {
  const record: NeedsRepair = { ...i.repair, reason: i.repair.reason ?? 'conflict', at: new Date().toISOString(), securityUpdate: i.securityUpdate && i.signed };
  writeNeedsRepair(i.dataDir, record);
  const plan = planUpdate({ failed: true, securityUpdate: i.securityUpdate, signed: i.signed, policy: i.policy });
  if (plan.action === 'update-without-failing') {
    const r = disableForUpdate(i.dataDir, record, i.by);
    const rec = readNeedsRepair(i.dataDir)!;
    return { plan, record: rec, rev: r.rev, notice: needsRepairNotice(rec) };
  }
  return { plan, record, rev: null, notice: needsRepairNotice(record) };
}
