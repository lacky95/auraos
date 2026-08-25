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
 *       │                  │ git fetch + ff-only merge
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
 *   • Never discard the user's work. A dirty worktree or a non-fast-forward
 *     upstream aborts the update instead of resetting over it.
 *   • Never leave the OS down. If the new revision doesn't answer, the
 *     updater restores the previous one and rebuilds it.
 *   • Never lie about what happened. Every step appends to the job log,
 *     including the failure paths.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

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
 * What a run actually does. All three share the same machinery — detached
 * container, job file, checklist, transcript — because all three destroy the
 * shell that would otherwise be supervising them.
 *
 *   update   fetch + rebase + rebuild + recreate + verify (with rollback)
 *   rebuild  rebuild the image from the checkout AS IS, recreate, verify.
 *            No git: for picking up local edits, or retrying a failed build.
 *   restart  recreate nothing, just restart the master container and verify.
 */
export type UpdateMode = 'update' | 'rebuild' | 'restart';

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
  { key: 'rebase',   label: 'Checkout moved to the new revision' },
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
  /** Commits this checkout is behind / ahead of the remote branch. */
  behind: number;
  ahead: number;
  /** Subject line of the newest upstream commit, for the confirm dialog. */
  latestSubject?: string;
  /** Tracked files with uncommitted changes (first few), when not clean. */
  dirtyFiles: string[];
}

interface DockerMount { Type?: string; Name?: string; Destination?: string }

const UPDATER_NAME = 'aura-updater';

export class SelfUpdater {
  constructor(private readonly dataDir: string) {}

  jobsDir(): string { return join(this.dataDir, 'aura', 'update'); }
  private jobFile(id: string): string { return join(this.jobsDir(), `${id}.json`); }

  /** Read one job, or the most recent one when no id is given. */
  readJob(id?: string): UpdateJob | null {
    try {
      const dir = this.jobsDir();
      if (!existsSync(dir)) return null;
      let file: string;
      if (id) {
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

  /** True while a job is neither finished nor failed — the UI disables the button. */
  isRunning(): boolean {
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
    try { writeFileSync(this.jobFile(job.id), JSON.stringify(closed, null, 2)); } catch { /* best effort */ }
    return closed;
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
    } catch (err) {
      out.blockers.push(`Could not reach ${remote.fetchUrl} (${branch}): ${(err as Error).message.split('\n')[0]}`);
    }
    return out;
  }

  /**
   * Launch the updater. Returns the job id immediately — the work outlives
   * this process, so there is nothing to await.
   */
  start(opts: { mode?: UpdateMode; branch?: string; dryRun?: boolean } = {}):
      { ok: true; job: UpdateJob } | { ok: false; reason: string } {
    const mode: UpdateMode = opts.mode ?? 'update';
    if (this.isRunning()) return { ok: false, reason: 'An update is already running.' };
    const probed = this.probe();
    if (!probed.ok) return { ok: false, reason: probed.reason };
    // Git preconditions apply to `update` only. A rebuild deliberately builds
    // whatever is on disk — uncommitted edits included, that being the point —
    // and a restart touches neither git nor the image.
    if (mode === 'update') {
      // Re-run the checks here rather than trusting the caller: the UI's
      // pre-flight result can be minutes stale, and a dirty tree that appeared
      // in between must not get rebuilt over.
      const pre = this.preflight(opts.branch ?? 'main');
      if (pre.blockers.length) return { ok: false, reason: pre.blockers[0]! };
    }

    const branch = (opts.branch ?? 'main').trim();
    if (!/^[A-Za-z0-9._\/-]{1,120}$/.test(branch)) {
      return { ok: false, reason: `Invalid branch name: ${branch}` };
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

    // --rm so a finished updater doesn't linger; the job file is the record.
    // The host workspace is bound at /workspace (same path the shell sees) so
    // git and the build act on the real checkout, not a copy.
    const args = [
      'run', '--detach', '--rm',
      '--name', `${UPDATER_NAME}-${id}`,
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
      // replace the command — so point HOME somewhere that exists unaided.
      '-e', 'HOME=/root',
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
    return { ok: true, job };
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

/** Human label for the button that started a run. */
function describeMode(mode: UpdateMode, branch: string, dryRun: boolean): string {
  const base = mode === 'update'  ? `Update — pull ${branch} and rebuild`
             : mode === 'rebuild' ? 'Rebuild — image from the current checkout'
             :                      'Restart — master container only';
  return dryRun ? `${base} (dry run)` : base;
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
DRY=${dry}
PROJECT=${JSON.stringify(o.project)}
COMPOSE_FILE=${JSON.stringify(o.composeFile)}
HEALTH=http://aura-shell:3000/api/os/about
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

# Job file updates go through node (already in the image) so the JSON can
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
  for k in inspect fetch rebase; do step "$k" skipped "$MODE does not touch git"; done
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
  fail "Uncommitted changes in $WS — commit or stash them first (the rebase needs a clean tree)."
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
step rebase running
# Rebase, not merge: local commits on this machine get REPLAYED on top of
# upstream, so the machine ends up on latest without a merge bubble and
# without losing local work. A conflict is a human decision — abort and leave
# the checkout exactly as it was rather than stopping mid-rebase, which would
# strand the machine on a detached HEAD with no shell to fix it from.
LOCAL_AHEAD=$(g rev-list --count FETCH_HEAD..HEAD 2>/dev/null || echo 0)
if [ "$LOCAL_AHEAD" != "0" ]; then
  say pulling "replaying $LOCAL_AHEAD local commit(s) onto the fetched $BRANCH"
fi
if ! g rebase FETCH_HEAD 2>&1 | tee -a "$LOGFILE" | tail -4; then
  g rebase --abort 2>/dev/null || true
  chown -R "$OWNER" "$WS/.git" 2>/dev/null || true
  fail "rebase onto $BRANCH hit a conflict — aborted, checkout unchanged. Resolve it manually."
fi
TO_REV=$(g rev-parse HEAD)
setrev toRev "$TO_REV"
step rebase done "\${FROM_REV:0:12} → \${TO_REV:0:12}"
# git ran as root in here; hand the objects back to whoever owns the checkout
# so the host user's own git keeps working.
chown -R "$OWNER" "$WS/.git" 2>/dev/null || true

if [ "$FROM_REV" = "$TO_REV" ]; then
  step rebase done "already at \${TO_REV:0:12}"
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
  say done "updated to \${TO_REV:0:12} and healthy"
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
    say done "updated to \${TO_REV:0:12} and healthy"
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
