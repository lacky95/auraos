import type { APIRoute } from 'astro';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * How the shell runs: `dev` (astro dev, HMR) or `prod` (the astro build via
 * server.mjs). Docs: deep-dive/shell-runtime-modes.
 *
 *   GET → { running, configured, env }
 *         running    — the mode of this process
 *         configured — the persistent switch (/data/aura/shell-mode), null = unset (dev)
 *         env        — AURA_SHELL_MODE on the container, which wins over the file
 *   PUT { mode: 'dev' | 'prod' } → writes the switch; takes effect on the next
 *         boot (`aura restart os`).
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
    running: (import.meta.env.DEV ? 'dev' : 'prod') as Mode,
    configured: readConfigured(),
    env,
  };
}

export const GET: APIRoute = () => json(state());

export const PUT: APIRoute = async ({ request }) => {
  let body: { mode?: unknown };
  try { body = await request.json() as { mode?: unknown }; } catch { return json({ error: 'body must be JSON: { mode }' }, 400); }
  if (body.mode !== 'dev' && body.mode !== 'prod') return json({ error: "mode must be 'dev' or 'prod'" }, 400);
  try {
    mkdirSync(dirname(MODE_FILE), { recursive: true });
    writeFileSync(MODE_FILE, `${body.mode}\n`, 'utf8');
  } catch (err) {
    return json({ error: `cannot write ${MODE_FILE}: ${(err as Error).message}` }, 500);
  }
  return json({ ok: true, ...state() });
};
