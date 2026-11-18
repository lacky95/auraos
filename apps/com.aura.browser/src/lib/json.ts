// Shared JSON helpers for the history / bookmarks routes.
export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export async function guard(fn: () => Promise<Response>): Promise<Response> {
  try { return await fn(); }
  catch (err: any) { return json({ error: String(err?.message ?? err) }, 500); }
}

export async function body(request: Request): Promise<any> {
  try { return await request.json(); } catch { return {}; }
}
