import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';

/**
 * First-boot setup status — today that is the `aura-base` image build
 * (lib/onboarding/setupCard.ts), which the "Setting up AuraOS" notification
 * follows.
 *
 * GET         → { image, phase, progress, step, startedAt, finishedAt, error }
 * GET ?log=1  → text/plain, last 256 KB of the build transcript
 * POST        → retry after a failed build (no-op while building or ready); 202
 */
const base = () => core.getBaseImage({ dataDir: process.env['AURA_DATA_DIR'] ?? '/data' });

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = ({ url }) => {
  if (url.searchParams.has('log')) {
    const text = base().readLog();
    return new Response(text ?? 'No build has run in this AuraOS — the base image was already there.', {
      status: text ? 200 : 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  return json(base().current);
};

export const POST: APIRoute = () => {
  const b = base();
  void b.ensure().catch(() => undefined);
  return json(b.current, 202);
};
