import type { APIRoute } from 'astro';

/**
 * Boot timelines reported by desktop tabs (lib/bootTimeline.ts), so a boot
 * can be read without the browser's DevTools — a phone WebView, a headless
 * test browser, an agent:
 *
 *   POST { url, ua, rows: [{ mark, ms, delta, detail }], stages, … }
 *        — sent once per page load, only while the tab's `shell:boot` log
 *          filter is on (`?log=shell:*`, Settings → General → Frontend logging).
 *   GET  → { reports: [newest first] }   (the last 20, in memory only)
 *
 *   curl -s $OS_API_BASE/api/os/boot-report | jq '.reports[0].rows'
 */
interface BootReport { at: string; [k: string]: unknown }

const MAX = 20;
const MAX_BYTES = 64 * 1024;
const KEY = '__auraBootReports';

function store(): BootReport[] {
  const g = globalThis as unknown as Record<string, BootReport[] | undefined>;
  return (g[KEY] ??= []);
}

export const GET: APIRoute = () =>
  new Response(JSON.stringify({ reports: store() }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const POST: APIRoute = async ({ request }) => {
  const text = await request.text();
  if (text.length > MAX_BYTES) return new Response('too large', { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return new Response('bad json', { status: 400 }); }
  if (!body || typeof body !== 'object' || !Array.isArray((body as { rows?: unknown }).rows)) {
    return new Response('expected { rows: [...] }', { status: 400 });
  }
  const reports = store();
  reports.unshift({ at: new Date().toISOString(), ...(body as Record<string, unknown>) });
  reports.length = Math.min(reports.length, MAX);
  return new Response(null, { status: 204 });
};
