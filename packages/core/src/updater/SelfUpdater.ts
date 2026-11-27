/**
 * Self-update: rebuild and recreate the master container from inside AuraOS.
 *
 * The awkward part is that the thing being replaced is the thing running the
 * update. `docker compose up -d --build aura-os` recreates aura-shell, so a
 * shell process that ran it would be SIGKILLed somewhere in the middle —
 * usually right after the build, leaving the fleet half-updated with nobody
 * left to health-check or roll back.
 *
 * So the shell doesn't do the update. It launches a DETACHED SIBLING
 * container that does, and then gets out of the way:
 *
 *     shell ──spawns──▶ updater (own container, own lifetime)
 *       │                  │ git fetch + ff-only merge (Developer Mode)
 *       ✝ killed by ◀──────┤ docker compose up -d --build aura-os
 *         the recreate     │ poll the new shell until it answers
 *       ▲ new shell        │ roll back to the previous rev if it never does
 *       └──reads job file──┘ write final status
 *
 * The updater runs from the SAME image as the shell, so there is nothing to
 * pull and it already has git, node and the docker CLI. It writes progress to
 * a job file on the app-data volume, which is exactly how the NEW shell (a
 * different process, minutes later) reports what happened: the UI polls the
 * job, not the process.
 *
 * Everything machine-specific is discovered at runtime from the shell's own
 * container — image, compose project, compose file, app-data volume — so this
 * works on any host without configuration.
 *
 * Safety rules, in order of how much they matter:
 *   • Never discard the user's work. A dirty worktree, local commits or a
 *     non-fast-forward upstream abort the update instead of replaying or
 *     resetting over it (Developer Mode: the owner manages git, D4/5.2).
 *   • Never leave the OS down. If the new revision doesn't answer, the
 *     updater restores the previous one and rebuilds it.
 *   • Never lie about what happened. Every step appends to the job log,
 *     including the failure paths.
 *
 * Normal mode (Phase 6 stream U): the same updater activates a built release
 * (mode `release`) or goes back to the previous one (mode `rollback`). Its
 * file work is os/release/activate.mjs, run from the RUNNING release's own
 * tree (`/data/releases/<current>`, the trusted side), step by step: the
 * activation lock for the whole job, re-verification, kernel stop, the data
 * snapshot, the atomic pointer switch with writes held, start, health, the
 * "accepting writes" point, and the automatic rollback (release AND data)
 * only before writes were accepted (Q35). Building a release is the release
 * builder's (os/release/builder.mjs, `startBuild`) in the same kind of
 * detached container.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { layout, RELEASE_ID_RE } from '../release/paths.js';
import { latestSnapshotInto, systemLockHolder } from '../release/activate.js';

/**
 * Docker Compose plugin version the updater installs when running from an
 * image that predates it. Mirrors the Dockerfile's COMPOSE_VERSION ARG —
 * bump both together.
 */
const COMPOSE_PLUGIN_VERSION = '2.40.3';

export type UpdatePhase =
  | 'queued' | 'checking' | 'pulling' | 'building' | 'verifying'
  | 'rolling-back' | 'done' | 'failed' | 'rolled-back';

/**
 * What a run actually does. All share the same machinery — detached
 * container, job file, checklist, transcript — because all destroy the
 * shell that would otherwise be supervising them.
 *
 *   update   Developer Mode: fetch + fast-forward + rebuild + recreate + verify
 *            (with rollback). Local commits refuse: the owner manages git.
 *   rebuild  rebuild the image from the checkout AS IS, recreate, verify.
 *            No git: for picking up local edits, or retrying a failed build.
 *   restart  recreate nothing, just restart the master container and verify.
 *   release  Normal mode: activate a built release (snapshot, switch, writes
 *            held, health, accept writes; automatic rollback before that).
 *   rollback Normal mode: back to the previous release; its data only when
 *            the owner chose to restore the snapshot (Q35).
 */
export type UpdateMode = 'update' | 'rebuild' | 'restart' | 'release' | 'rollback';
export const RELEASE_MODES: ReadonlySet<UpdateMode> = new Set(['release', 'rollback']);

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/**
 * One line of the update checklist. The point is to answer "what actually
 * happened?" without reading a transcript: was the image really rebuilt, did
 * the health check pass, did a rollback run. `skipped` is a first-class
 * answer — a dry run legitimately never builds.
 */
export interface UpdateStep {
  key: string;
  label: string;
  status: StepStatus;
  /** Short result, e.g. the rev moved to or why a step was skipped. */
  detail?: string;
  /** When the step last changed state. */
  at?: string;
}

/** The checklist, in the order the updater performs it. */
export const UPDATE_STEPS: ReadonlyArray<{ key: string; label: string }> = [
  // Not a step the updater performs — it records WHICH button started this
  // run, so a finished checklist explains itself without knowing which of the
  // three was pressed. Set at job creation, hence already done.
  { key: 'action',   label: 'Action triggered' },
  { key: 'inspect',  label: 'Workspace inspected (git checkout, clean tree)' },
  { key: 'fetch',    label: 'Latest commit fetched from the remote' },
  { key: 'forward',  label: 'Checkout fast-forwarded to the new revision' },
  { key: 'compose',  label: 'Docker Compose available' },
  { key: 'build',    label: 'Image rebuilt' },
  { key: 'recreate', label: 'Master container recreated' },
  { key: 'restart',  label: 'Master container restarted' },
  { key: 'verify',   label: 'New shell answered a health check' },
  { key: 'rollback', label: 'Rollback (only if the update failed)' },
  // Written by the updater as its LAST act, on every exit path. Its purpose
  // is not to restate the phase: it is the backend acknowledging that the
  // process ran to the end. A job whose other steps look finished while this
  // one is still pending means the updater died — killed, host rebooted, OOM
  // — and nobody would otherwise have noticed.
  { key: 'complete', label: 'Done — process finished and acknowledged' },
];

/**
 * The checklist of a release activation or rollback (Phase 6 U), in order.
 * `drain` is the shell's (lib/plannedRestart.ts: desktop saved, apps told)
 * and done at job creation; the rest is the updater's.
 */
export const RELEASE_STEPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'action',   label: 'Action triggered' },
  { key: 'drain',    label: 'Desktop saved, apps told to get ready' },
  { key: 'lock',     label: 'Activation lock taken' },
  { key: 'verify',   label: 'Release verified (complete, tree digest, signature)' },
  { key: 'stop',     label: 'Kernel stopped (apps keep running)' },
  { key: 'snapshot', label: 'Data snapshot taken (Valkey + migrations)' },
  { key: 'switch',   label: 'Release pointer switched' },
  { key: 'restore',  label: 'Data snapshot restored (only when chosen)' },
  { key: 'start',    label: 'Master container started on the release' },
  { key: 'health',   label: 'Release healthy (kernel, services, probe)' },
  { key: 'accept',   label: 'Accepting writes' },
  { key: 'rollback', label: 'Automatic rollback (only if the release failed before accepting writes)' },
  { key: 'complete', label: 'Done — process finished and acknowledged' },
];

/** The checklist of a mode. */
export const stepsOf = (mode: UpdateMode): ReadonlyArray<{ key: string; label: string }> =>
  (RELEASE_MODES.has(mode) ? RELEASE_STEPS : UPDATE_STEPS);

export interface UpdateJob {
  id: string;
  phase: UpdatePhase;
  /** Per-step outcome — see {@link UPDATE_STEPS}. */
  steps: UpdateStep[];
  startedAt: string;
  finishedAt?: string;
  mode: UpdateMode;
  branch: string;
  dryRun: boolean;
  fromRev?: string;
  toRev?: string;
  /** Release modes: the release left, the release switched to, the snapshot taken or restored. */
  fromRelease?: string;
  toRelease?: string;
  snapshot?: string | null;
  /** `rollback`: the owner chose to restore the data snapshot too (Q35). */
  restoreData?: boolean;
  /** `release`: Terminal sessions (D35) switch now, or on their next start (default). */
  when?: 'now' | 'next-start';
  /** Set by the shell once it audited and announced a finished release job (boot report). */
  reported?: string;
  error?: string;
  /** Human-readable progress, newest last. */
  log: string[];
}

/**
 * Result of the cheap, synchronous check that runs in the SHELL process the
 * moment the user clicks — before anything heavy is launched.
 */
export interface UpdatePreflight {
  /** Every blocker found. Empty means it is safe to start the updater. */
  blockers: string[];
  /** True when origin/<branch> has commits this checkout doesn't. */
  updateAvailable: boolean;
  clean: boolean;
  branch: string;
  currentRev?: string;
  latestRev?: string;
  /** Commits this checkout is behind / ahead of the remote branch (ahead refuses: the owner manages git). */
  behind: number;
  ahead: number;
  /** Subject line of the newest upstream commit, for the confirm dialog. */
  latestSubject?: string;
  /** Tracked files with uncommitted changes (first few), when not clean. */
  dirtyFiles: string[];
}

interface DockerMount { Type?: string; Name?: string; Destination?: string }

/** What `start()` takes; the release fields only for the modes `release` and `rollback`. */
export interface StartOptions {
  mode?: UpdateMode;
  branch?: string;
  dryRun?: boolean;
  /** `release`: the built release to switch to. */
  releaseId?: string;
  /** `release`: D35, Terminal sessions switch now or on their next start (default). */
  when?: 'now' | 'next-start';
  /** `rollback`: also restore the data snapshot of the switch into the current release (Q35). */
  restoreData?: boolean;
  /** `rollback`: the advisories the owner confirmed (a non-critical security rollback, 5b answer 1). */
  confirmInsecure?: string;
  /** The caller drained (lib/plannedRestart.ts): the `drain` step is done. */
  drained?: boolean;
}

/** The fields of release.json the updater reads (core release/types.ts ReleaseManifest). */
interface ReleaseRecordLite { id?: string; images?: { shell?: string } }

function readJsonFile<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, 'utf-8')) as T; } catch { return null; }
}

/** POSIX single-quoting for a generated command line. */
const shq = (w: string): string => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

/** The Developer-Mode refusal of local commits (D4/5.2, D36: no rebase). */
export const developerAheadMessage = (ahead: number, branch: string): string =>
  `Developer Mode: ${ahead} local commit(s) are not on ${branch}; the owner manages git (push or move them, then update). The updater only fast-forwards.`;

const UPDATER_NAME = 'aura-updater';

/** A job id: its start time, `new Date().toISOString()` with `:` and `.` as `-`. Never a path. */
export const UPDATE_JOB_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
/** A branch to update from. Never an option: it is passed to git. */
export const UPDATE_BRANCH_RE = /^(?!-)[A-Za-z0-9._\/-]{1,120}$/;

export class SelfUpdater {
  constructor(private readonly dataDir: string) {}

  jobsDir(): string { return join(this.dataDir, 'aura', 'update'); }

  /** The marker os/boot.sh looks for (BUILD_REQUEST there); removed after the build. */
  bootBuildRequestFile(): string { return join(this.dataDir, 'aura', 'boot', 'build-requested'); }
  /**
   * Ask the next boot to build what changed (os/boot.sh). Update and Rebuild
   * do it themselves; a shell-mode switch and `aura dev rebuild` ask before a
   * plain restart. Never throws.
   */
  requestBootBuild(reason: string): void {
    try {
      mkdirSync(join(this.dataDir, 'aura', 'boot'), { recursive: true });
      writeFileSync(this.bootBuildRequestFile(), `${reason} ${new Date().toISOString()}\n`);
    } catch (err) {
      console.warn(`[SelfUpdater] cannot request a build for the next boot: ${(err as Error).message}`);
    }
  }
  private jobFile(id: string): string { return join(this.jobsDir(), `${id}.json`); }

  /**
   * Read one job, or the most recent one when no id is given. Reads only: a
   * job whose updater is gone comes back closed, and is written so by the
   * next `start()`.
   */
  readJob(id?: string): UpdateJob | null {
    try {
      const dir = this.jobsDir();
      if (!existsSync(dir)) return null;
      let file: string;
      if (id !== undefined) {
        if (!UPDATE_JOB_ID_RE.test(id)) return null;
        file = this.jobFile(id);
      } else {
        const names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
        const latest = names[names.length - 1];
        if (!latest) return null;
        file = join(dir, latest);
      }
      if (!existsSync(file)) return null;
      return this.reapIfAbandoned(JSON.parse(readFileSync(file, 'utf-8')) as UpdateJob);
    } catch { return null; }
  }

  /** Full transcript of a run: every command's real output, not just the
   *  step summaries in the job's `log`. This is what you actually need when a
   *  build fails — compose's error is in here, not in the phase list. */
  readLog(id: string): string | null {
    if (!UPDATE_JOB_ID_RE.test(id)) return null;
    try {
      const file = join(this.jobsDir(), `${id}.log`);
      if (!existsSync(file)) return null;
      const text = readFileSync(file, 'utf-8');
      // Cap what we hand a browser: a failing build can print a lot, and the
      // interesting part is always the end.
      const MAX = 256 * 1024;
      return text.length > MAX ? `… (truncated)\n${text.slice(-MAX)}` : text;
    } catch { return null; }
  }

  /**
   * True while a job is neither finished nor failed, or while a release job
   * (a build, an activation) holds the `system` activation lock — the UI
   * disables the button.
   */
  isRunning(): boolean {
    if (systemLockHolder(this.dataDir)) return true;
    const job = this.readJob();
    if (!job) return false;
    return !['done', 'failed', 'rolled-back'].includes(job.phase);
  }

  /**
   * Close out a job whose updater is gone.
   *
   * The final `complete` step is written by the updater as its last act, so a
   * job that has no acknowledgement AND no live container behind it did not
   * finish — the container was killed, the host rebooted, docker restarted.
   * Without this the UI would poll a phantom run forever and the buttons
   * would stay disabled with no way back.
   *
   * The 90s grace is for the gap between spawning the container and docker
   * having it inspectable; reaping inside that window would kill every run at
   * birth.
   */
  private reapIfAbandoned(job: UpdateJob): UpdateJob {
    if (['done', 'failed', 'rolled-back'].includes(job.phase)) return job;
    const startedMs = Date.parse(job.startedAt);
    if (Number.isFinite(startedMs) && Date.now() - startedMs < 90_000) return job;
    try {
      const out = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', `${UPDATER_NAME}-${job.id}`],
        { stdio: ['ignore', 'pipe', 'ignore'], timeout: 8_000, encoding: 'utf-8' }).trim();
      if (out === 'true') return job;   // still working
    } catch { /* container gone → fall through and close the job out */ }
    const closed: UpdateJob = {
      ...job,
      phase: 'failed',
      finishedAt: new Date().toISOString(),
      error: 'the updater process disappeared before it finished',
      steps: job.steps.map((st) => (
        st.key === 'complete' ? { ...st, status: 'failed' as StepStatus, detail: 'updater process disappeared', at: new Date().toISOString() }
        : st.status === 'running' ? { ...st, status: 'failed' as StepStatus, at: new Date().toISOString() }
        : st
      )),
      log: [...job.log, 'the updater container is gone and never acknowledged completion — marking this run failed'],
    };
    return closed;
  }

  /** Write the latest job closed when its updater is gone (`start()` only: reads never write). */
  private settleAbandoned(): void {
    const job = this.readJob();
    if (!job || !UPDATE_JOB_ID_RE.test(job.id) || job.phase !== 'failed' || !job.finishedAt) return;
    try {
      const stored = JSON.parse(readFileSync(this.jobFile(job.id), 'utf-8')) as UpdateJob;
      if (stored.phase !== 'failed') writeFileSync(this.jobFile(job.id), JSON.stringify(job, null, 2));
    } catch { /* best effort */ }
  }

  /**
   * Everything the updater needs about THIS machine, read off the shell's own
   * container. Returns null with a reason when self-update can't work here —
   * the caller turns that into a plain message rather than a half-attempt.
   */
  probe(): { ok: true; image: string; project: string; composeFile: string; workDir: string; appDataVolume: string; network: string }
       | { ok: false; reason: string } {
    if (!existsSync('/var/run/docker.sock')) {
      return { ok: false, reason: 'No docker socket — self-update needs /var/run/docker.sock bound into the shell.' };
    }
    const ref = this.ownContainerRef();
    if (!ref) return { ok: false, reason: 'Could not identify the shell container.' };
    let info: { Config?: { Image?: string; Labels?: Record<string, string> }; Mounts?: DockerMount[];
                NetworkSettings?: { Networks?: Record<string, unknown> } };
    try {
      const out = execFileSync('docker', ['inspect', '-f', '{{json .}}', ref],
        { stdio: ['ignore', 'pipe', 'ignore'], timeout: 8_000, encoding: 'utf-8' }).trim();
      info = JSON.parse(out) as typeof info;
    } catch (err) {
      return { ok: false, reason: `docker inspect failed: ${(err as Error).message}` };
    }
    const labels = info.Config?.Labels ?? {};
    const project     = labels['com.docker.compose.project'] ?? '';
    const composeFile = (labels['com.docker.compose.project.config_files'] ?? '').split(',')[0] ?? '';
    const workDir     = labels['com.docker.compose.project.working_dir'] ?? '';
    if (!project || !composeFile) {
      return { ok: false, reason: 'The shell was not started by docker compose — self-update rebuilds via compose.' };
    }
    const appDataVolume = (info.Mounts ?? [])
      .find((m) => m.Type === 'volume' && m.Destination === '/data')?.Name;
    if (!appDataVolume) return { ok: false, reason: 'No app-data volume mounted at /data.' };
    const image = info.Config?.Image;
    if (!image) return { ok: false, reason: 'Could not resolve the shell image.' };
    // NOTE: no compose check here. The plugin ships in the image (see the
    // Dockerfile), and on a machine still running an older image the updater
    // downloads it before building — everything the updater needs is either
    // present by default or self-provisioned, never a prerequisite the user
    // has to satisfy by hand.
    const network = Object.keys(info.NetworkSettings?.Networks ?? {})[0] ?? 'bridge';
    return { ok: true, image, project, composeFile, workDir, appDataVolume, network };
  }

  /**
   * The remote to update from, and a URL the CONTAINER can actually fetch.
   *
   * Two things the obvious implementation gets wrong: the remote is not
   * necessarily called "origin" (this repo's is "github"), and it is usually
   * an SSH URL — but no sandbox has the user's SSH key, and it must not. For
   * a public repo the https:// form of the same remote fetches anonymously,
   * which is exactly the access an updater should have: read the public
   * history, never push.
   */
  private remoteInfo(branch: string): { remote: string; fetchUrl: string } | null {
    const ws = '/workspace';
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', ws, '-c', 'safe.directory=' + ws, ...args],
        { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000, encoding: 'utf-8' }).trim();
    let remote = '';
    try { remote = git('config', '--get', `branch.${branch}.remote`); } catch { /* not tracking */ }
    if (!remote) {
      let all: string[] = [];
      try { all = git('remote').split('\n').filter(Boolean); } catch { return null; }
      remote = all.includes('origin') ? 'origin' : (all[0] ?? '');
    }
    if (!remote) return null;
    let url = '';
    try { url = git('remote', 'get-url', remote); } catch { return null; }
    // git@host:owner/repo.git → https://host/owner/repo.git ; ssh:// likewise.
    const scp = url.match(/^[^@]+@([^:]+):(.+)$/);
    if (scp) url = `https://${scp[1]}/${scp[2]}`;
    else url = url.replace(/^ssh:\/\/[^@]+@/, 'https://');
    return { remote, fetchUrl: url };
  }

  /**
   * Cheap pre-flight, run in-process on click. Answers the two questions that
   * decide whether starting a heavy updater is worth it and safe:
   *
   *   1. Is there anything to update?  (fetch + count commits behind)
   *   2. Would updating destroy work?  (is the worktree clean)
   *
   * Deliberately does NOT mutate the checkout: `git fetch` only moves remote
   * refs, so a user who clicks Check and then walks away is left exactly
   * where they were. The expensive, destructive part is a separate, explicit
   * step. Takes a couple of seconds on a normal network.
   */
  preflight(branch = 'main'): UpdatePreflight {
    const out: UpdatePreflight = {
      blockers: [], updateAvailable: false, clean: true, branch,
      behind: 0, ahead: 0, dirtyFiles: [],
    };
    const ws = '/workspace';
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', ws, '-c', 'safe.directory=' + ws, ...args],
        { stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000, encoding: 'utf-8' }).trim();

    if (!UPDATE_BRANCH_RE.test(branch)) {
      out.blockers.push(`Invalid branch name: ${branch}`);
      return out;
    }
    const probed = this.probe();
    if (!probed.ok) out.blockers.push(probed.reason);
    if (this.isRunning()) out.blockers.push('An update is already running.');

    try { git('rev-parse', '--git-dir'); }
    catch { out.blockers.push('/workspace is not a git checkout — nothing to update from.'); return out; }

    // Uncommitted TRACKED changes only: untracked files (user apps, notes,
    // scratch) are none of the updater's business and are never touched.
    try {
      const dirty = git('status', '--porcelain', '--untracked-files=no');
      if (dirty) {
        out.clean = false;
        // Porcelain v1 is "XY <path>": two status columns, then the path — and
        // a rename is "R  old -> new". The column count is {0,2} rather than
        // exactly 2 because git() trims, which eats the leading space of an
        // unstaged first line (" M foo" arrives as "M foo").
        out.dirtyFiles = dirty.split('\n')
          .map((l) => l.replace(/^.{0,2}\s+/, '').split(' -> ').pop() ?? '')
          .filter(Boolean).slice(0, 10);
        out.blockers.push(`Working tree has uncommitted changes (${out.dirtyFiles.length}+ files) — commit or stash first.`);
      }
    } catch { /* treat as clean; the updater re-checks before touching anything */ }

    try { out.currentRev = git('rev-parse', 'HEAD'); } catch { /* ignore */ }

    const remote = this.remoteInfo(branch);
    if (!remote) { out.blockers.push('No git remote configured to update from.'); return out; }
    try {
      // Fetch by URL into FETCH_HEAD: it needs no remote-tracking ref, so the
      // check works the same whether or not this machine tracks the branch,
      // and it leaves the local refs untouched.
      git('fetch', '--quiet', remote.fetchUrl, branch);
      out.latestRev = git('rev-parse', 'FETCH_HEAD');
      const counts = git('rev-list', '--left-right', '--count', 'HEAD...FETCH_HEAD').split(/\s+/);
      out.ahead  = Number(counts[0] ?? 0);
      out.behind = Number(counts[1] ?? 0);
      out.updateAvailable = out.behind > 0;
      if (out.behind > 0) out.latestSubject = git('log', '-1', '--format=%s', 'FETCH_HEAD');
      // Developer Mode updates fast-forward only (D36: no rebase of local commits, owner question i).
      if (out.ahead > 0) out.blockers.push(developerAheadMessage(out.ahead, branch));
    } catch (err) {
      out.blockers.push(`Could not reach ${remote.fetchUrl} (${branch}): ${(err as Error).message.split('\n')[0]}`);
    }
    return out;
  }

  /**
   * Launch the updater. Returns the job id immediately — the work outlives
   * this process, so there is nothing to await.
   */
  start(opts: StartOptions = {}): { ok: true; job: UpdateJob } | { ok: false; reason: string } {
    const mode: UpdateMode = opts.mode ?? 'update';
    if (RELEASE_MODES.has(mode)) return this.startRelease(mode, opts);
    const branch = (opts.branch ?? 'main').trim();
    if (!UPDATE_BRANCH_RE.test(branch)) {
      return { ok: false, reason: `Invalid branch name: ${branch}` };
    }
    if (this.isRunning()) return { ok: false, reason: 'An update is already running.' };
    this.settleAbandoned();
    const probed = this.probe();
    if (!probed.ok) return { ok: false, reason: probed.reason };
    // Git preconditions apply to `update` only. A rebuild deliberately builds
    // whatever is on disk — uncommitted edits included, that being the point —
    // and a restart touches neither git nor the image.
    if (mode === 'update') {
      // Re-run the checks here rather than trusting the caller: the UI's
      // pre-flight result can be minutes stale, and a dirty tree that appeared
      // in between must not get rebuilt over.
      const pre = this.preflight(branch);
      if (pre.blockers.length) return { ok: false, reason: pre.blockers[0]! };
    }

    const dryRun = opts.dryRun === true;
    // Timestamped id: sorts chronologically, so "latest job" is a plain sort.
    const id = new Date().toISOString().replace(/[:.]/g, '-');
    const job: UpdateJob = {
      id, phase: 'queued', startedAt: new Date().toISOString(),
      mode, branch, dryRun,
      steps: UPDATE_STEPS.map((s) => (s.key === 'action'
        ? { ...s, status: 'done' as StepStatus, detail: describeMode(mode, branch, dryRun), at: new Date().toISOString() }
        : { ...s, status: 'pending' as StepStatus })),
      log: [`queued: ${mode}${mode === 'update' ? ` (branch=${branch})` : ''}${dryRun ? ' [dry-run]' : ''}`],
    };
    mkdirSync(this.jobsDir(), { recursive: true });
    writeFileSync(this.jobFile(id), JSON.stringify(job, null, 2));
    // Update and Rebuild are where packages get built: ask the next boot
    // (os/boot.sh) to build what changed. A plain restart never builds —
    // except a first boot without any build output.
    if (!dryRun && (mode === 'update' || mode === 'rebuild')) this.requestBootBuild(mode);

    // Same remote resolution the pre-flight used: the remote is often not
    // called "origin" and is usually SSH, which no sandbox can authenticate.
    const remote = mode === 'update' ? this.remoteInfo(branch) : { remote: '', fetchUrl: '' };
    if (!remote) return { ok: false, reason: 'No git remote configured to update from.' };

    const script = updaterScript({
      jobFile: `/data/aura/update/${id}.json`,
      logFile: `/data/aura/update/${id}.log`,
      fetchUrl: remote.fetchUrl,
      mode,
      branch, dryRun,
      project: probed.project,
      composeFile: probed.composeFile,
      workDir: probed.workDir,
    });
    const launched = this.launch(`${UPDATER_NAME}-${id}`, probed, script);
    return launched.ok ? { ok: true, job } : launched;
  }

  /**
   * Normal mode: activate a built release, or go back to the previous one.
   * The mechanical checks only (the shell's route ran the preflight, the
   * security rule and the owner's approval before it drained): a pointer, a
   * complete target, the snapshot a data restore needs.
   */
  private startRelease(mode: UpdateMode, opts: StartOptions): { ok: true; job: UpdateJob } | { ok: false; reason: string } {
    if (this.isRunning()) return { ok: false, reason: 'An update or release job is already running.' };
    this.settleAbandoned();
    const L = layout(this.dataDir);
    const pointer = readJsonFile<{ current?: string; previous?: string | null; jobId?: string }>(L.pointer);
    if (!pointer?.current || !RELEASE_ID_RE.test(pointer.current)) return { ok: false, reason: 'This install does not run from a release (Normal mode): nothing to activate.' };
    const from = pointer.current;
    const to = mode === 'release' ? opts.releaseId : (pointer.previous ?? undefined);
    if (!to || !RELEASE_ID_RE.test(to)) {
      return { ok: false, reason: mode === 'release' ? 'No release id to activate.' : 'There is no previous release to roll back to.' };
    }
    if (to === from) return { ok: false, reason: `Release ${to} is already current.` };
    const toRec = readJsonFile<ReleaseRecordLite>(join(L.release(to), 'release.json'));
    const fromRec = readJsonFile<ReleaseRecordLite>(join(L.release(from), 'release.json'));
    if (!existsSync(join(L.release(to), '.complete')) || !toRec) return { ok: false, reason: `Release ${to} is not complete.` };
    if (!fromRec) return { ok: false, reason: `The running release ${from} has no record: it cannot be the trusted side of an activation.` };
    let restoreSnapshot: string | null = null;
    if (mode === 'rollback' && opts.restoreData) {
      // Only the snapshot of the switch INTO the current release: never data from across two updates (Q35).
      const snap = latestSnapshotInto(this.dataDir, from, pointer.jobId);
      if (!snap) return { ok: false, reason: `No data snapshot of the switch to ${from}: the data cannot be restored (the release alone can be rolled back).` };
      restoreSnapshot = snap;
    }
    const probed = this.probe();
    if (!probed.ok) return { ok: false, reason: probed.reason };

    const id = new Date().toISOString().replace(/[:.]/g, '-');
    const now = new Date().toISOString();
    const when = opts.when === 'now' ? 'now' : 'next-start';
    const job: UpdateJob = {
      id, phase: 'queued', startedAt: now, mode, branch: '', dryRun: false,
      fromRelease: from, toRelease: to, snapshot: restoreSnapshot, ...(mode === 'rollback' ? { restoreData: Boolean(restoreSnapshot) } : { when }),
      steps: RELEASE_STEPS.map((s) => (s.key === 'action'
        ? { ...s, status: 'done' as StepStatus, detail: describeRelease(mode, from, to, Boolean(restoreSnapshot)), at: now }
        : s.key === 'drain'
          ? { ...s, status: (opts.drained ? 'done' : 'skipped') as StepStatus, detail: opts.drained ? 'desktop saved' : 'not drained by the caller', at: now }
          : { ...s, status: 'pending' as StepStatus })),
      log: [`queued: ${mode} ${from} → ${to}${restoreSnapshot ? ` (restoring data snapshot ${restoreSnapshot})` : ''}`],
    };
    mkdirSync(this.jobsDir(), { recursive: true });
    writeFileSync(this.jobFile(id), JSON.stringify(job, null, 2));
    const script = releaseScript({
      jobFile: `/data/aura/update/${id}.json`, logFile: `/data/aura/update/${id}.log`, jobId: id, mode,
      from, to, restoreSnapshot, fromImage: fromRec.images?.shell ?? '', toImage: toRec.images?.shell ?? '',
      project: probed.project, composeFile: probed.composeFile, workDir: probed.workDir,
      confirmInsecure: opts.confirmInsecure ?? '',
    });
    const launched = this.launch(`${UPDATER_NAME}-${id}`, probed, script);
    return launched.ok ? { ok: true, job } : launched;
  }

  /**
   * Build a release (Normal mode, `aura release build`): the release builder
   * (os/release/builder.mjs, stream B) from the running release's trusted
   * tree, in a detached container like the updater's. The builder takes the
   * activation lock and writes its job to `aura/release/jobs/<id>.json`.
   */
  startBuild(opts: { fetchFrom: string; channel: 'signed' | 'main'; maturity?: string; ref?: string; composition: 'desktop' | 'server' }):
      { ok: true; jobId: string } | { ok: false; reason: string } {
    if (this.isRunning()) return { ok: false, reason: 'An update or release job is already running.' };
    const L = layout(this.dataDir);
    const pointer = readJsonFile<{ current?: string }>(L.pointer);
    if (!pointer?.current || !RELEASE_ID_RE.test(pointer.current)) return { ok: false, reason: 'This install does not run from a release (Normal mode): the first release is built by install.sh.' };
    if (!/^(https:\/\/|\/)\S+$/.test(opts.fetchFrom)) return { ok: false, reason: 'The release source must be an https URL or a local path (aura/release/source.json).' };
    if (opts.ref !== undefined && !/^v?[0-9A-Za-z][0-9A-Za-z.+_-]{0,100}$/.test(opts.ref)) return { ok: false, reason: `Invalid release ref: ${opts.ref}` };
    if (opts.maturity !== undefined && !['alpha', 'beta', 'stable'].includes(opts.maturity)) return { ok: false, reason: `Invalid maturity: ${opts.maturity}` };
    const probed = this.probe();
    if (!probed.ok) return { ok: false, reason: probed.reason };
    const jobId = new Date().toISOString().replace(/[:.]/g, '-');
    const trusted = `/data/releases/${pointer.current}`;
    const argv = [
      'node', `${trusted}/os/release/builder.mjs`, 'build', '--data-root', '/data', '--data-volume', probed.appDataVolume,
      '--fetch-from', opts.fetchFrom, '--channel', opts.channel, '--composition', opts.composition, '--job', jobId,
      ...(opts.channel === 'signed' ? ['--keys', `${trusted}/os/release-keys`, ...(existsSync(L.trustedKeys) ? ['--keys', '/data/aura/release/trusted-keys'] : [])] : []),
      ...(opts.maturity ? ['--maturity', opts.maturity] : []),
      ...(opts.ref ? ['--ref', opts.ref] : []),
    ];
    const script = `set -uo pipefail\nmkdir -p /data/aura/release/jobs\n${argv.map(shq).join(' ')} > /data/aura/release/jobs/${jobId}.out 2>&1\n`;
    const launched = this.launch(`aura-release-build-${jobId}`, probed, script);
    return launched.ok ? { ok: true, jobId } : launched;
  }

  /** One detached updater container (`--rm`; the job file is the record). */
  private launch(name: string, probed: Extract<ReturnType<SelfUpdater['probe']>, { ok: true }>, script: string): { ok: true } | { ok: false; reason: string } {
    // --rm so a finished updater doesn't linger; the job file is the record.
    // The host workspace is bound at /workspace (same path the shell sees) so
    // git and the build act on the real checkout, not a copy.
    const args = [
      'run', '--detach', '--rm',
      '--name', name,
      '--network', probed.network,
      '-v', '/var/run/docker.sock:/var/run/docker.sock',
      // Mount the checkout at its HOST path, not /workspace. Compose runs in
      // HERE but the daemon runs out THERE: every bind in docker-compose.yml
      // is resolved by the daemon against the host filesystem, so compose has
      // to see the project at the same absolute path the host does. Mounting
      // it at /workspace instead would make `.:/workspace` bind the updater's
      // view — a path that doesn't exist on the host — into the new shell.
      '-v', `${probed.workDir}:${probed.workDir}`,
      '-v', `${probed.appDataVolume}:/data`,
      '-w', probed.workDir,
      // The image's HOME (/home/master) is a symlink its CMD creates, and we
      // replace the command — so point HOME at the symlink's target, which
      // lives on the app-data volume we just mounted and so exists unaided.
      // It has to be a real home, not /root: git reads the credential helper
      // from $HOME/.gitconfig, and without it the fetch goes out anonymous.
      // GitHub answers unauthenticated protocol-v2 upload-pack with an
      // intermittent 401, which git turns into a username prompt it cannot
      // answer — an update that fails on GitHub's throttle, not on our state.
      '-e', `HOME=${updaterHome()}`,
      probed.image,
      'bash', '-lc', script,
    ];
    try {
      // Detached + unref: the updater must survive this process being killed
      // by the very recreate it is about to perform.
      const child = spawn('docker', args, { stdio: 'ignore', detached: true });
      child.unref();
    } catch (err) {
      return { ok: false, reason: `could not launch updater: ${(err as Error).message}` };
    }
    return { ok: true };
  }

  /** @see ContainerRunner.getOwnContainerId — same trick, same reasons. */
  private ownContainerRef(): string | null {
    try {
      const id = readFileSync('/proc/self/mountinfo', 'utf-8').match(/\/containers\/([0-9a-f]{64})\//)?.[1];
      if (id) return id;
    } catch { /* not in a container */ }
    return process.env['AURA_SHELL_HOSTNAME'] || hostname() || null;
  }
}

/**
 * $HOME for the updater container.
 *
 * The shell's own /home/master is a symlink into the app-data volume, and that
 * volume is mounted at the same /data path inside the updater — so the resolved
 * target is valid in both containers, while the symlink itself is not (the
 * image's CMD creates it, and the updater replaces the command). Anything
 * outside /data would not survive the crossing, so fall back to /root: the
 * fetch then runs unauthenticated, which is degraded but not broken.
 */
function updaterHome(): string {
  try {
    const real = realpathSync(process.env['HOME'] || '/home/master');
    if (real === '/data' || real.startsWith('/data/')) return real;
  } catch { /* no home to resolve */ }
  return '/root';
}

/** Human label for a release activation or rollback. */
function describeRelease(mode: UpdateMode, from: string, to: string, restoreData: boolean): string {
  return mode === 'release'
    ? `Activate release ${to} (from ${from})`
    : `Roll back to ${to} (from ${from})${restoreData ? ', restoring the data snapshot' : ', data kept'}`;
}

/** Human label for the button that started a run. */

function describeMode(mode: UpdateMode, branch: string, dryRun: boolean): string {
  const base = mode === 'update'  ? `Update — pull ${branch} and rebuild`
             : mode === 'rebuild' ? 'Rebuild — image from the current checkout'
             :                      'Restart — master container only';
  return dryRun ? `${base} (dry run)` : base;
}

/** The job-file helpers every updater program shares (say, setrev, step, fail). */
const JOB_HELPERS = `# Job file updates go through node (already in the image) so the JSON can
# never be corrupted by shell quoting of a commit subject or an error string.
say() {
  node -e '
    const fs=require("fs"); const [f,phase,line]=process.argv.slice(1);
    let j={}; try{ j=JSON.parse(fs.readFileSync(f,"utf8")); }catch{}
    if(phase) j.phase=phase;
    if(line){ j.log=(j.log||[]).concat(line); }
    if(["done","failed","rolled-back"].includes(phase)) j.finishedAt=new Date().toISOString();
    fs.writeFileSync(f, JSON.stringify(j,null,2));
  ' "$JOB" "$1" "$2" || true
  echo "[$(date -u +%H:%M:%S)] $2" | tee -a "$LOGFILE"
}
setrev() {
  node -e '
    const fs=require("fs"); const [f,k,v]=process.argv.slice(1);
    let j={}; try{ j=JSON.parse(fs.readFileSync(f,"utf8")); }catch{}
    j[k]=v; fs.writeFileSync(f, JSON.stringify(j,null,2));
  ' "$JOB" "$1" "$2" || true
}
# Mark one checklist entry. Same node-based JSON edit as say(), for the same
# reason: shell quoting must never be able to corrupt the job file.
step() {
  node -e '
    const fs=require("fs"); const [f,key,status,detail]=process.argv.slice(1);
    let j={}; try{ j=JSON.parse(fs.readFileSync(f,"utf8")); }catch{}
    j.steps=(j.steps||[]).map(s=> s.key===key
      ? {...s, status, detail: detail || s.detail, at:new Date().toISOString()} : s);
    fs.writeFileSync(f, JSON.stringify(j,null,2));
  ' "$JOB" "$1" "$2" "\${3:-}" || true
}
# Whatever was in flight when we give up is what failed; anything never
# reached stays "pending" rather than pretending to be skipped on purpose.
fail() {
  node -e '
    const fs=require("fs"); const [f]=process.argv.slice(1);
    let j={}; try{ j=JSON.parse(fs.readFileSync(f,"utf8")); }catch{}
    j.steps=(j.steps||[]).map(s=> s.status==="running" ? {...s, status:"failed", at:new Date().toISOString()} : s);
    fs.writeFileSync(f, JSON.stringify(j,null,2));
  ' "$JOB" || true
  step complete failed "$1"
  say failed "$1"
  exit 1
}
`;

/**
 * Render the updater program for a given run. Exported for tests: this is
 * generated shell, so `tsc` can prove nothing about it — every previous bug
 * in here (a backtick ending the template early, a variable only the update
 * path assigns) was invisible to the type checker and fatal at runtime.
 *
 * @see test/updater-script.test.mjs, which executes it against stubbed
 * docker/git/curl for every mode.
 */
export function renderUpdaterScript(o: {
  jobFile: string; logFile: string; fetchUrl: string; mode: UpdateMode; branch: string; dryRun: boolean;
  project?: string; composeFile?: string; workDir?: string;
}): string {
  return updaterScript({
    project: 'aura',
    composeFile: '/workspace/docker-compose.yml',
    workDir: '/workspace',
    ...o,
  });
}

/**
 * The updater's program. Plain bash so it can be read (and run by hand) on any
 * machine, and so it has no dependency on the node/TS build of the revision it
 * is in the middle of replacing.
 */
function updaterScript(o: {
  jobFile: string; logFile: string; fetchUrl: string; mode: UpdateMode; branch: string; dryRun: boolean;
  project: string; composeFile: string; workDir: string;
}): string {
  const dry = o.dryRun ? '1' : '0';
  return `
set -uo pipefail
JOB=${o.jobFile}
LOGFILE=${o.logFile}
WS=${JSON.stringify(o.workDir)}
BRANCH=${JSON.stringify(o.branch)}
FETCH_URL=${JSON.stringify(o.fetchUrl)}
MODE=${JSON.stringify(o.mode)}
# Only the update path sets these. Under 'set -u' an unset variable is fatal,
# so a rebuild/restart referencing one in a message would abort the script
# AFTER the work succeeded — losing the final status and leaving the job stuck
# on its last phase forever. Default them.
FROM_REV=none
TO_REV=none
DRY=${dry}
PROJECT=${JSON.stringify(o.project)}
COMPOSE_FILE=${JSON.stringify(o.composeFile)}
# The public, minimal health probe (the route access manifest allows it
# without a credential; /api/os/about is the owner's).
HEALTH=http://aura-shell:3000/api/auth/status
COMPOSE_VERSION=${COMPOSE_PLUGIN_VERSION}   # keep in step with the Dockerfile ARG
# A first boot after a rebuild runs pnpm install and builds every package —
# minutes, sometimes many. So the health wait is NOT a plain timeout: it gives
# up only when the new shell stops making progress, and otherwise keeps
# waiting up to a generous hard cap. Rolling back a slow-but-fine build would
# be far worse than waiting.
POLL=10            # seconds between checks
MAX_WAIT=2700      # 45 min hard cap, even while progressing
STALL_LIMIT=36     # 36 x 10s = 6 min with no new container output = stuck
GONE_LIMIT=6       # 6 x 10s = 1 min of the container not running at all

${JOB_HELPERS}
# Every git call goes through g(): -C for the repo, and safe.directory inline
# rather than via a global git config, which writes to $HOME — and $HOME in
# this container is a symlink the image's CMD creates, which never ran because
# we replaced the command. Inline config depends on nothing.
g() { git -C "$WS" -c safe.directory="$WS" "$@"; }
mkdir -p "$(dirname "$LOGFILE")"; : > "$LOGFILE"

# Second opinion on "it's stuck": GRACE seconds of watching before we accept
# that a rollback is warranted. Returns 0 (stuck) only if the container is
# neither answering nor producing any output for the whole window.
GRACE=180
confirm_stuck() {
  local before after t
  before=$(shell_log_size)
  say verifying "no response yet — watching $(( GRACE / 60 ))m more before deciding to roll back"
  t=0
  while [ "$t" -lt "$GRACE" ]; do
    if ping_ok; then return 1; fi
    sleep "$POLL"; t=$(( t + POLL ))
  done
  after=$(shell_log_size)
  if ping_ok; then return 1; fi
  # Output during the grace window means the boot is alive, just slow.
  if [ "\${after:-0}" -gt "\${before:-0}" ]; then return 1; fi
  say verifying "no output and no response for $(( GRACE / 60 ))m — confirming it is stuck"
  return 0
}

if [ "$MODE" != "update" ]; then
  # No git in a rebuild or a restart: those act on what is already checked out.
  for k in inspect fetch forward; do step "$k" skipped "$MODE does not touch git"; done
fi

if [ "$MODE" = "update" ]; then
step inspect running
say checking "inspecting the workspace"
if ! g rev-parse --git-dir >/dev/null 2>&1; then
  fail "$WS is not a git checkout — nothing to update from."
fi
# Refuse to build over uncommitted work: the rebuild would bake it in, and a
# rollback would then have to throw it away. Untracked files are fine (user
# apps, notes) — only tracked modifications block.
if [ -n "$(g status --porcelain --untracked-files=no)" ]; then
  fail "Uncommitted changes in $WS — commit or stash them first (an update needs a clean tree)."
fi
FROM_REV=$(g rev-parse HEAD)
setrev fromRev "$FROM_REV"
step inspect done "clean tree at \${FROM_REV:0:12}"
OWNER=$(stat -c '%u:%g' "$WS")

ON_BRANCH=$(g rev-parse --abbrev-ref HEAD)
if [ "$ON_BRANCH" != "$BRANCH" ]; then
  say checking "switching $ON_BRANCH → $BRANCH"
  g checkout "$BRANCH" 2>&1 | tail -2 || fail "could not check out $BRANCH"
fi

step fetch running
say pulling "fetching $BRANCH from $FETCH_URL"
g fetch "$FETCH_URL" "$BRANCH" 2>&1 | tee -a "$LOGFILE" | tail -3 || fail "git fetch failed"
step fetch done
step forward running
# Fast-forward only (D36, owner question i): local commits are the owner's
# (Developer Mode: the owner manages git), so they are never replayed or reset
# over. A local commit or a non-fast-forward upstream refuses and leaves the
# checkout exactly as it was.
LOCAL_AHEAD=$(g rev-list --count FETCH_HEAD..HEAD 2>/dev/null || echo 0)
if [ "$LOCAL_AHEAD" != "0" ]; then
  step forward failed "$LOCAL_AHEAD local commit(s)"
  fail "Developer Mode: $LOCAL_AHEAD local commit(s) are not on $BRANCH; the owner manages git (push or move them, then update). Nothing was changed."
fi
if ! g merge --ff-only FETCH_HEAD 2>&1 | tee -a "$LOGFILE" | tail -4; then
  chown -R "$OWNER" "$WS/.git" 2>/dev/null || true
  fail "$BRANCH cannot be fast-forwarded to the fetched revision; nothing was changed. Resolve it in git."
fi
TO_REV=$(g rev-parse HEAD)
setrev toRev "$TO_REV"
step forward done "\${FROM_REV:0:12} → \${TO_REV:0:12}"
# git ran as root in here; hand the objects back to whoever owns the checkout
# so the host user's own git keeps working.
chown -R "$OWNER" "$WS/.git" 2>/dev/null || true

if [ "$FROM_REV" = "$TO_REV" ]; then
  step forward done "already at \${TO_REV:0:12}"
  for k in compose build recreate restart verify rollback; do step "$k" skipped "nothing to update"; done
  step complete done "nothing to do"
  say done "already up to date at \${TO_REV:0:12} — nothing to build"
  exit 0
fi
say pulling "updated \${FROM_REV:0:12} → \${TO_REV:0:12}"

fi   # end MODE=update git section

if [ "$DRY" = "1" ]; then
  for k in compose build recreate restart verify rollback; do step "$k" skipped "dry run"; done
  step complete done "dry run finished"
  say done "dry run: would $MODE '$PROJECT' from $COMPOSE_FILE"
  exit 0
fi

# Compose is baked into the image, but a machine updating FROM an older image
# won't have it yet. Fetch the pinned plugin rather than telling the user to
# go run a command on the host: an update already requires network, and the
# next build bakes it in for good.
ensure_compose() {
  if docker compose version >/dev/null 2>&1; then return 0; fi
  say building "docker compose plugin missing from this image — fetching v$COMPOSE_VERSION"
  mkdir -p /usr/local/lib/docker/cli-plugins
  curl -fsSL "https://github.com/docker/compose/releases/download/v$COMPOSE_VERSION/docker-compose-linux-$(uname -m)" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose || return 1
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  docker compose version >/dev/null 2>&1
}
rebuild() {
  # Full build output to the transcript, last lines to the job summary.
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --project-directory "$WS" up -d --build aura-os 2>&1 \
    | tee -a "$LOGFILE" | tail -5
}
# Final "it worked" line, phrased for the mode that ran: only an update has a
# revision to name.
finish_ok() {
  if [ "$MODE" = "update" ]; then
    say done "updated to \${TO_REV:0:12} and healthy"
  else
    say done "$MODE finished — aura-shell is up and healthy"
  fi
}
ping_ok() { [ "$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$HEALTH" 2>/dev/null)" = 200 ]; }
shell_running() { [ "$(docker inspect -f '{{.State.Running}}' aura-shell 2>/dev/null || echo false)" = true ]; }
shell_log_size() { docker logs aura-shell 2>&1 | wc -c | tr -d ' '; }

# Wait for the new shell, distinguishing "slow" from "stuck":
#   • answers 200                        → healthy, done
#   • container up and its log GROWING   → still installing/building, keep waiting
#   • container up but log frozen 6 min  → stuck, give up
#   • container not running for 1 min    → crashed or crash-looping, give up
# Progress is reported into the job so the UI can say "still building" instead
# of looking hung.
healthy() {
  local started now last_size size stalled gone waited
  started=$(date +%s); last_size=0; stalled=0; gone=0
  while :; do
    if ping_ok; then return 0; fi
    now=$(date +%s); waited=$(( now - started ))
    if [ "$waited" -ge "$MAX_WAIT" ]; then
      say verifying "gave up after $(( waited / 60 ))m — the new shell never answered"
      return 1
    fi
    if shell_running; then
      gone=0
      size=$(shell_log_size)
      if [ "\${size:-0}" -gt "$last_size" ]; then
        # Output since the last check: the boot is doing something. Only
        # report every ~2 min so the job log stays readable.
        if [ $(( stalled % 12 )) -eq 0 ]; then
          say verifying "still starting up ($(( waited / 60 ))m) — container is building/booting"
        fi
        last_size=$size
        stalled=0
      else
        stalled=$(( stalled + 1 ))
        if [ "$stalled" -ge "$STALL_LIMIT" ]; then
          say verifying "no output from aura-shell for $(( STALL_LIMIT * POLL / 60 ))m and still not answering — treating as stuck"
          return 1
        fi
      fi
    else
      gone=$(( gone + 1 ))
      if [ "$gone" -ge "$GONE_LIMIT" ]; then
        say verifying "aura-shell is not running $(( GONE_LIMIT * POLL ))s after the rebuild — treating as failed"
        return 1
      fi
    fi
    sleep "$POLL"
  done
}

if [ "$MODE" = "restart" ]; then
  for k in compose build recreate rollback; do step "$k" skipped "restart only"; done
  step restart running
  say building "restarting aura-shell"
  OLD_STARTED=$(docker inspect -f '{{.State.StartedAt}}' aura-shell 2>/dev/null || echo none)
  if ! docker restart aura-shell >/dev/null 2>&1; then
    step restart failed "docker restart failed"
    fail "could not restart aura-shell"
  fi
  NEW_STARTED=$(docker inspect -f '{{.State.StartedAt}}' aura-shell 2>/dev/null || echo none)
  if [ "$NEW_STARTED" = "$OLD_STARTED" ]; then
    step restart failed "container start time unchanged"
  else
    step restart done "restarted at $NEW_STARTED"
  fi
  step verify running
  say verifying "waiting for the shell to come back"
  if healthy; then
    step verify done "answered after the restart"
    step complete done "restart finished"
    say done "aura-shell restarted and healthy"
    exit 0
  fi
  step verify failed "no response after the restart"
  fail "aura-shell did not come back after the restart"
fi

# rebuild and update share everything from here down.
step restart skipped "container is recreated, not restarted"
step compose running
if ! ensure_compose; then
  fail "docker compose is unavailable and could not be downloaded — cannot rebuild."
fi
step compose done "$(docker compose version --short 2>/dev/null || echo available)"

# Container identity BEFORE the rebuild. Comparing it afterwards is what
# turns "compose exited 0" into "the master container was really replaced" —
# a compose run can succeed and leave an unchanged container (nothing to do),
# which would otherwise be reported as a successful recreate.
OLD_ID=$(docker inspect -f '{{.Id}}' aura-shell 2>/dev/null || echo none)

step build running
say building "[$MODE] rebuilding the image and recreating aura-shell — this blocks until the build finishes, so no rollback can interrupt it (kills the old shell at the end)"
if ! rebuild; then
  step build failed "compose build/up failed"
  if [ "$MODE" != "update" ]; then
    step rollback skipped "nothing to roll back to — the checkout was not changed"
    fail "the build failed; the checkout is untouched, so there is nothing to revert"
  fi
  step rollback running
say rolling-back "build failed — restoring \${FROM_REV:0:12}"
  g reset --hard "$FROM_REV" >/dev/null 2>&1
  chown -R "$OWNER" "$WS/.git" 2>/dev/null || true
  rebuild || true
  if healthy; then
  step rollback done "restored \${FROM_REV:0:12}"
  step complete done "finished — build failed, previous revision restored"
  say rolled-back "build failed; restored \${FROM_REV:0:12}"
else
  step rollback failed "restore did not come up"
  step complete failed "finished — neither revision is up"
  say failed "build failed and the restore did not come up — manual attention needed"
fi
  exit 1
fi

step build done
NEW_ID=$(docker inspect -f '{{.Id}}' aura-shell 2>/dev/null || echo none)
if [ "$NEW_ID" = none ]; then
  step recreate failed "aura-shell is not present after the rebuild"
elif [ "$NEW_ID" = "$OLD_ID" ]; then
  # Same container: compose decided nothing changed. The new code is on disk
  # but is NOT running, so say so instead of implying a restart happened.
  step recreate failed "container unchanged (\${OLD_ID:0:12}) — compose did not replace it"
else
  step recreate done "\${OLD_ID:0:12} → \${NEW_ID:0:12}"
fi

step verify running
say verifying "waiting for the new shell — a first boot installs deps and builds every package, so this can take several minutes"
if healthy; then
  step verify done "answered on the new revision"
  step rollback skipped "not needed"
  step complete done "$MODE finished"
  finish_ok
  exit 0
fi

# LAST GUARD BEFORE ROLLING BACK. healthy() already refuses to give up while
# the container is producing output, but rolling back a good build is the most
# expensive mistake this script can make — so before touching anything, sit
# for one more grace period and look again. If the container so much as logs a
# line, or comes up, in that window, we were early: keep waiting.
if ! confirm_stuck; then
  say verifying "still working after all — resuming the wait"
  if healthy; then
    step verify done "answered on the new revision (after a longer wait)"
    step rollback skipped "not needed"
    step complete done "$MODE finished"
    finish_ok
    exit 0
  fi
  confirm_stuck || true
fi

step verify failed "no response from the new shell"
if [ "$MODE" != "update" ]; then
  step rollback skipped "nothing to roll back to — the checkout was not changed"
  fail "the rebuilt shell never answered; the checkout is unchanged, so there is nothing to revert"
fi
step rollback running
say rolling-back "\${TO_REV:0:12} never became healthy — restoring \${FROM_REV:0:12}"
g reset --hard "$FROM_REV" >/dev/null 2>&1
chown -R "$OWNER" "$WS/.git" 2>/dev/null || true
rebuild || true
if healthy; then
  step rollback done "restored \${FROM_REV:0:12}"
  step complete done "finished — update reverted"
  say rolled-back "restored \${FROM_REV:0:12}; the update to \${TO_REV:0:12} was reverted"
else
  step rollback failed "restore did not come up either"
  step complete failed "finished — neither revision is up"
  say failed "neither \${TO_REV:0:12} nor \${FROM_REV:0:12} came up — manual attention needed"
fi
exit 1
`;
}

// ── release activation and rollback (Normal mode, Phase 6 U) ───────────────

interface ReleaseScriptInput {
  jobFile: string; logFile: string; jobId: string; mode: UpdateMode;
  from: string; to: string; restoreSnapshot: string | null; fromImage: string; toImage: string;
  project: string; composeFile: string; workDir: string; confirmInsecure: string;
  /** Tests: the data root, the activation module, the shell's base URL, the health budget and poll (s). */
  dataDir?: string; activate?: string; shellUrl?: string; healthBudget?: number; poll?: number;
}

/** Render the release program (exported for tests, like renderUpdaterScript: it is generated shell). */
export function renderReleaseScript(o: Omit<ReleaseScriptInput, 'project' | 'composeFile' | 'workDir'> & Partial<ReleaseScriptInput>): string {
  return releaseScript({ project: 'aura', composeFile: '/workspace/docker-compose.yml', workDir: '/workspace', ...o });
}

/**
 * The release program: every file step is os/release/activate.mjs from the
 * RUNNING release's tree (the trusted side; nothing of the target runs
 * before it verified), the container steps are docker. Before "accepting
 * writes" any failure rolls back release AND data (Q35); after it, nothing
 * here touches the data again (a later rollback is the owner's).
 */
function releaseScript(o: ReleaseScriptInput): string {
  const data = o.dataDir ?? '/data';
  const act = o.activate ?? `${data}/releases/${o.from}/os/release/activate.mjs`;
  const url = o.shellUrl ?? 'http://aura-shell:3000';
  return `
set -uo pipefail
JOB=${JSON.stringify(o.jobFile)}
LOGFILE=${JSON.stringify(o.logFile)}
ID=${JSON.stringify(o.jobId)}
MODE=${JSON.stringify(o.mode)}
DATA=${JSON.stringify(data)}
FROM=${JSON.stringify(o.from)}
TO=${JSON.stringify(o.to)}
RESTORE_SNAPSHOT=${JSON.stringify(o.restoreSnapshot ?? '')}
FROM_IMAGE=${JSON.stringify(o.fromImage)}
TO_IMAGE=${JSON.stringify(o.toImage)}
CONFIRM_INSECURE=${JSON.stringify(o.confirmInsecure)}
TRUSTED="$DATA/releases/$FROM"
ACT=${JSON.stringify(act)}
SHELL_URL=${JSON.stringify(url)}
HEALTH="$SHELL_URL/api/auth/status"
PROJECT=${JSON.stringify(o.project)}
COMPOSE_FILE=${JSON.stringify(o.composeFile)}
WS=${JSON.stringify(o.workDir)}
POLL=${o.poll ?? 5}
# No build at boot in Normal mode: a release that is not healthy in 5 min is not (plan §5 U step 9).
BUDGET=${o.healthBudget ?? 300}
SNAP=""
mkdir -p "$(dirname "$LOGFILE")"; : > "$LOGFILE"

${JOB_HELPERS}
act() { node "$ACT" "$@" --data "$DATA" 2>>"$LOGFILE"; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s)[process.argv[1]];process.stdout.write(v==null?"":String(v));}catch{}})' "$1"; }
ping_ok() { [ "$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$HEALTH" 2>/dev/null)" = 200 ]; }
shell_running() { [ "$(docker inspect -f '{{.State.Running}}' aura-shell 2>/dev/null || echo false)" = true ]; }
running_image() { docker inspect -f '{{.Config.Image}}' aura-shell 2>/dev/null || echo none; }

# Start the master container on the release the pointer names: a plain start
# when the image is the same (release-entry.sh reads the pointer), a recreate
# with the release's image when it differs (stream L: the release compose
# file reads AURA_SHELL_IMAGE).
start_shell() {
  local img="$1"
  if [ -n "$img" ] && [ "$(running_image)" != "$img" ]; then
    AURA_SHELL_IMAGE="$img" docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --project-directory "$WS" up -d --no-build --force-recreate aura-os 2>&1 | tee -a "$LOGFILE" | tail -3
  else
    docker start aura-shell >/dev/null 2>&1
  fi
}

# Health: the probe answers AND the kernel's status.json says ready, with
# every service resumed, for a boot after SINCE. 0 healthy, 1 failed or out
# of budget (HEALTH_REASON says why).
HEALTH_REASON=""
wait_healthy() {
  local since="$1" started now verdict code gone=0
  started=$(date +%s)
  while :; do
    verdict=$(act health --since "$since"); code=$?
    if [ "$code" = 0 ] && ping_ok; then return 0; fi
    if [ "$code" = 1 ]; then HEALTH_REASON=$(printf '%s' "$verdict" | field failed); return 1; fi
    if shell_running; then gone=0; else gone=$(( gone + 1 )); fi
    if [ "$gone" -ge 6 ]; then HEALTH_REASON="aura-shell is not running"; return 1; fi
    now=$(date +%s)
    if [ $(( now - started )) -ge "$BUDGET" ]; then
      HEALTH_REASON="not healthy after \${BUDGET}s; waiting for: $(printf '%s' "$verdict" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write((JSON.parse(s).waiting||[]).join(", ")||"the health probe")}catch{process.stdout.write("the health probe")}})')"
      return 1
    fi
    sleep "$POLL"
  done
}

# The lock holder lives as long as this program (heartbeat every 30 s).
LOCKOUT="$(dirname "$LOGFILE")/$ID.lock.out"
release_lock() { if [ -n "\${LOCKPID:-}" ]; then kill "$LOCKPID" 2>/dev/null; wait "$LOCKPID" 2>/dev/null; fi; rm -f "$LOCKOUT"; }
trap release_lock EXIT
step lock running
say checking "taking the activation lock"
node "$ACT" hold-lock --data "$DATA" --job "$ID" --by "system.release.$MODE" > "$LOCKOUT" 2>>"$LOGFILE" &
LOCKPID=$!
for _ in $(seq 1 50); do
  grep -q '"ok": true' "$LOCKOUT" 2>/dev/null && break
  kill -0 "$LOCKPID" 2>/dev/null || break
  sleep 0.2
done
if ! grep -q '"ok": true' "$LOCKOUT" 2>/dev/null; then
  REASON=$(field error < "$LOCKOUT")
  LOCKPID=""
  step lock failed "\${REASON:-the lock holder did not start}"
  fail "\${REASON:-the activation lock could not be taken}"
fi
step lock done "held by $ID"

step verify running
if [ "$MODE" = "rollback" ]; then
  # 5b owner answer 1: never back past a resolved critical fix; others only when confirmed.
  CHECK=$(act rollback-check --confirm-insecure "$CONFIRM_INSECURE") || { step verify failed "security rule"; fail "$(printf '%s' "$CHECK" | field reason)$(printf '%s' "$CHECK" | field error)"; }
fi
V=$(act verify --id "$TO" --trusted "$TRUSTED") || { step verify failed "$(printf '%s' "$V" | field error)"; fail "release $TO refused: $(printf '%s' "$V" | field error)"; }
step verify done "$TO: $(printf '%s' "$V" | field provenance)"

step stop running
say building "stopping the kernel (apps keep running and are adopted)"
docker stop -t 15 aura-shell >/dev/null 2>&1 || true
if shell_running; then step stop failed "aura-shell still running"; fail "could not stop aura-shell"; fi
step stop done

if [ "$MODE" = "release" ]; then
  step snapshot running
  S=$(act snapshot --to "$TO" --job "$ID") || { step snapshot failed "$(printf '%s' "$S" | field error)"; docker start aura-shell >/dev/null 2>&1; fail "the data snapshot failed; nothing was switched: $(printf '%s' "$S" | field error)"; }
  SNAP=$(printf '%s' "$S" | field id)
  setrev snapshot "$SNAP"
  step snapshot done "$SNAP"
  step switch running
  P=$(act switch --to "$TO" --job "$ID" --snapshot "$SNAP") || { step switch failed "$(printf '%s' "$P" | field error)"; act release-hold >/dev/null; docker start aura-shell >/dev/null 2>&1; fail "the switch failed; $FROM keeps running: $(printf '%s' "$P" | field error)"; }
  step switch done "$FROM → $TO (writes held)"
  step restore skipped "a release activation keeps the data"
else
  step snapshot skipped "a rollback takes no new snapshot"
  step switch running
  P=$(act revert --job "$ID") || { step switch failed "$(printf '%s' "$P" | field error)"; docker start aura-shell >/dev/null 2>&1; fail "the rollback switch failed: $(printf '%s' "$P" | field error)"; }
  step switch done "$FROM → $TO"
  # A rollback never boots held: this also ends an abandoned activation's hold.
  act release-hold >/dev/null
  if [ -n "$RESTORE_SNAPSHOT" ]; then
    step restore running
    R=$(act restore --snapshot "$RESTORE_SNAPSHOT") || { step restore failed "$(printf '%s' "$R" | field error)"; fail "the data restore failed (the pointer is on $TO; nothing was deleted): $(printf '%s' "$R" | field error)"; }
    step restore done "$RESTORE_SNAPSHOT (the replaced data is kept in the snapshot dir)"
  else
    step restore skipped "data kept (the owner did not choose a restore)"
  fi
  step accept skipped "a rollback does not hold writes"
  step rollback skipped "nothing to roll back to"
fi

step start running
SINCE=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
start_shell "$TO_IMAGE"
step start done "$(running_image)"
step health running
say verifying "waiting for $TO to become healthy (budget \${BUDGET}s)"
if wait_healthy "$SINCE"; then
  step health done "kernel ready, services resumed"
  if [ "$MODE" = "rollback" ]; then
    step complete done "rolled back to $TO"
    say done "rolled back to $TO"
    exit 0
  fi
  step accept running
  if A=$(act accept --job "$ID" --trusted "$TRUSTED" --url "$SHELL_URL"); then
    step accept done "via $(printf '%s' "$A" | field via)"
    step rollback skipped "not needed"
    step complete done "release $TO active"
    say done "release $TO is active and accepting writes"
    exit 0
  fi
  HEALTH_REASON="accept-writes refused: $(printf '%s' "$A" | field error)"
  step accept failed "$HEALTH_REASON"
else
  step health failed "$HEALTH_REASON"
fi

if [ "$MODE" = "rollback" ]; then
  fail "the rollback to $TO did not become healthy: $HEALTH_REASON (manual attention: release-ctl.sh on the host)"
fi
# Automatic rollback, before writes were accepted: release AND data (Q35).
step rollback running
setrev error "$HEALTH_REASON"
say rolling-back "$TO failed before accepting writes ($HEALTH_REASON) — restoring $FROM and its data"
docker stop -t 15 aura-shell >/dev/null 2>&1 || true
act revert --job "$ID" >/dev/null || { step rollback failed "pointer revert failed"; fail "the automatic rollback could not switch back (manual attention: release-ctl.sh rollback)"; }
act restore --snapshot "$SNAP" >/dev/null || { step rollback failed "snapshot restore failed"; fail "the automatic rollback could not restore the data snapshot $SNAP (the pointer is on $FROM; manual attention)"; }
act release-hold >/dev/null
SINCE=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
FAILED_REASON="$HEALTH_REASON"
start_shell "$FROM_IMAGE"
if wait_healthy "$SINCE"; then
  step rollback done "$FROM restored with its data ($SNAP)"
  step complete done "finished — $TO rolled back"
  say rolled-back "$TO failed before accepting writes ($FAILED_REASON); $FROM and its data are back"
  exit 1
fi
step rollback failed "$FROM did not come back either: $HEALTH_REASON"
step complete failed "finished — neither release is healthy"
say failed "neither $TO nor $FROM became healthy — manual attention needed (release-ctl.sh on the host)"
exit 1
`;
}
