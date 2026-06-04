import type { APIRoute } from 'astro';
import { createTab, loadFile, tabsSnapshot } from '../../state.js';

export const GET: APIRoute = () =>
  new Response(JSON.stringify(tabsSnapshot()), { headers: { 'Content-Type': 'application/json' } });

/**
 * POST creates a tab.
 *   {}                         → blank untitled tab
 *   { path, name, text }       → open a file: reuse the tab if that path is
 *                                already open, else create a named tab with the
 *                                content. Atomic — no untitled-then-rename flash.
 */
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({})) as {
    path?: string; name?: string; text?: string;
  };
  if (body.path && body.name) {
    const id = loadFile(body.path, body.name, body.text ?? '');
    return new Response(JSON.stringify({ id, name: body.name, path: body.path }),
      { status: 201, headers: { 'Content-Type': 'application/json' } });
  }
  const tab = createTab();
  return new Response(JSON.stringify(tab), { status: 201, headers: { 'Content-Type': 'application/json' } });
};
