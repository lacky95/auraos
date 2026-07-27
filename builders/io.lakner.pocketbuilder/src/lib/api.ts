/** Tiny helpers shared by this app's own API routes. */

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export function fail(message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error: message, ...extra }, status);
}

export async function readBody<T>(request: Request): Promise<T> {
  try { return await request.json() as T; }
  catch { throw new Error('Request body must be JSON.'); }
}
