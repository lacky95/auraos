import type { APIRoute } from 'astro';
import { SelfUpdater, UPDATE_BRANCH_RE, UPDATE_JOB_ID_RE } from '@aura/core';
import { plannedRestart } from '../../../lib/plannedRestart.js';

/**
 * Self-update control surface for Settings → About.
 *
 * GET  → { supported, running, job }   the latest job, plus whether this
 *         machine can self-update at all (compose-managed, docker socket).
 * GET ?logs=<id> → text/plain transcript of that run (build output and all).
 * GET ?check=1 → adds { preflight }    the on-click check: fetches origin,
 *         counts how far behind we are and whether the tree is clean. Runs
 *         IN THIS PROCESS (a couple of seconds, no container) so the user
 *         learns "nothing to update" or "you have uncommitted changes"
 *         immediately, instead of after a heavy updater has spun up.
 * POST { mode, restore? } → { ok, job }   launch a run — 'update' (default),
 *         'rebuild' (image from the current checkout, no git) or 'restart'
 *         (bounce the master container). 202, because the
 *         work outlives this request AND this whole process — the updater
 *         recreates the container serving it.
 *
 * GET only reads: it never writes a job file (an abandoned run is shown
 * closed, and written so by the next POST). Job ids and branch names are
 * checked here as well as in SelfUpdater: an id is never a path, and a
 * branch never a git option.
 *
 * The client must expect this endpoint to STOP ANSWERING mid-update and come
 * back a minute or two later on the new revision: that is the update working,
 * not failing. Progress lives in the job file on the app-data volume, so the
 * new shell can report on work its predecessor started.
 */
const updater = () => new SelfUpdater(process.env['AURA_DATA_DIR'] ?? '/data');

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

const MODES: ReadonlySet<string> = new Set(['update', 'rebuild', 'restart']);

export const GET: APIRoute = ({ url }) => {
  const u = updater();
  const job = url.searchParams.get('job');
  const branch = url.searchParams.get('branch') ?? 'main';
  if (job !== null && !UPDATE_JOB_ID_RE.test(job)) return json({ error: 'invalid-job-id' }, 400);
  if (!UPDATE_BRANCH_RE.test(branch)) return json({ error: 'invalid-branch' }, 400);
  // ?logs=<jobId> → the run's full transcript as plain text. Separate from the
  // status payload because it is unbounded: the UI fetches it only when the
  // user asks to see it.
  const logs = url.searchParams.get('logs');
  if (logs) {
    if (!UPDATE_JOB_ID_RE.test(logs)) return json({ error: 'invalid-job-id' }, 400);
    const text = u.readLog(logs);
    return new Response(text ?? 'No transcript for this run.', {
      status: text ? 200 : 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  const probed = u.probe();
  const body: Record<string, unknown> = {
    supported: probed.ok,
    reason: probed.ok ? undefined : probed.reason,
    running: u.isRunning(),
    job: u.readJob(job ?? undefined),
  };
  // Only on request: it costs a network round-trip to the git remote.
  if (url.searchParams.get('check') === '1') {
    body['preflight'] = u.preflight(branch);
  }
  return json(body);
};

export const POST: APIRoute = async ({ request }) => {
  let body: { mode?: 'update' | 'rebuild' | 'restart'; branch?: string; dryRun?: boolean; restore?: boolean } = {};
  try { body = await request.json() as typeof body; } catch { /* empty body is fine */ }
  if (!body || typeof body !== 'object') body = {};
  if (body.mode !== undefined && !MODES.has(body.mode)) return json({ ok: false, error: 'mode must be update, rebuild or restart' }, 400);
  if (body.branch !== undefined && (typeof body.branch !== 'string' || !UPDATE_BRANCH_RE.test(body.branch.trim()))) {
    return json({ ok: false, error: 'invalid branch name' }, 400);
  }
  if (body.dryRun) {
    const res = updater().start({ mode: body.mode, branch: body.branch, dryRun: true });
    if (!res.ok) return json({ ok: false, error: res.reason }, 409);
    return json({ ok: true, job: res.job }, 202);
  }
  // Every real run takes the container down: save the desktop first and bring
  // it back after (lib/plannedRestart.ts).
  const res = await plannedRestart({ mode: body.mode ?? 'update', branch: body.branch, restore: body.restore !== false });
  if (!res.ok) return json({ ok: false, error: res.error }, 409);
  return json({ ok: true, job: res.job, activities: res.activities }, 202);
};
