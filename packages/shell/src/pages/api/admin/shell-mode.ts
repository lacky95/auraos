import type { APIRoute } from 'astro';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { auditOwner, ownerAction } from '../../../lib/approvals/admin.ts';

/**
 * How the shell runs: `dev` (astro dev, HMR) or `prod` (the astro build via
 * server.mjs). Docs: deep-dive/shell-runtime-modes.
 *
 *   GET → { running, configured, env }
 *         running    — the mode of this process
 *         configured — the persistent switch (/data/aura/shell-mode), null = unset (dev)
 *         env        — AURA_SHELL_MODE on the container, which wins over the file
 *   PUT { mode: 'dev' | 'prod' } → writes the switch; takes effect on the next
 *         boot (`aura restart os`). The owner's (lib/approvals/admin.ts):
 *         the CLI in the System Terminal asks for one click.
 *
 * CLI: `aura shell mode [dev|prod]`.
 */
const MODE_FILE = '/data/aura/shell-mode';
type Mode = 'dev' | 'prod';

function readConfigured(): Mode | null {
  try {
    const v = readFileSync(MODE_FILE, 'utf8').trim();
    return v === 'prod' || v === 'dev' ? v : null;
  } catch { return null; }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function state() {
  const env = process.env['AURA_SHELL_MODE'] ?? null;
  return {
    // server.mjs (prod) sets AURA_SHELL_RUNTIME; `astro dev` never runs it.
    running: (process.env['AURA_SHELL_RUNTIME'] === 'prod' ? 'prod' : 'dev') as Mode,
    configured: readConfigured(),
    env,
  };
}

export const GET: APIRoute = () => json(state());

export const PUT: APIRoute = async (ctx) => {
  let body: { mode?: unknown };
  try { body = await ctx.request.json() as { mode?: unknown }; } catch { return json({ error: 'body must be JSON: { mode }' }, 400); }
  if (body.mode !== 'dev' && body.mode !== 'prod') return json({ error: "mode must be 'dev' or 'prod'" }, 400);
  const actor = await ownerAction(ctx, {
    action: 'admin.change', level: 'session', payload: { op: 'shell-mode', mode: body.mode },
    title: `Run the shell in ${body.mode} mode`, details: ['Takes effect on the next restart (aura restart os).'],
  });
  if (actor instanceof Response) return actor;
  try {
    const before = readConfigured();
    mkdirSync(dirname(MODE_FILE), { recursive: true });
    writeFileSync(MODE_FILE, `${body.mode}\n`, 'utf8');
    // A mode switch must build on the next boot (a plain restart does not):
    // the other mode's build may be stale or missing.
    if (before !== body.mode) new core.SelfUpdater(process.env['AURA_DATA_DIR'] ?? '/data').requestBootBuild(`shell-mode ${body.mode}`);
  } catch (err) {
    return json({ error: `cannot write ${MODE_FILE}: ${(err as Error).message}` }, 500);
  }
  await auditOwner(actor, 'shell-mode', { detail: { mode: body.mode } });
  return json({ ok: true, ...state() });
};
