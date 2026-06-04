import type { APIRoute } from 'astro';
import { closeTab, saveTabToPath, setTabText, tabDetail } from '../../../state.js';

export const GET: APIRoute = ({ params }) => {
  const detail = tabDetail(params['id']!);
  if (!detail) return new Response('not found', { status: 404 });
  return new Response(JSON.stringify(detail), { headers: { 'Content-Type': 'application/json' } });
};

export const PUT: APIRoute = async ({ params, request }) => {
  const id   = params['id']!;
  const body = await request.json().catch(() => ({})) as {
    text?: string; path?: string; name?: string;
  };
  if (body.path && body.name) {
    setTabText(id, body.text ?? tabDetail(id)?.text ?? '');
    saveTabToPath(id, body.path, body.name);
  } else if (typeof body.text === 'string') {
    setTabText(id, body.text);
  }
  const detail = tabDetail(id);
  return new Response(JSON.stringify(detail ?? {}), { headers: { 'Content-Type': 'application/json' } });
};

export const DELETE: APIRoute = ({ params }) => {
  closeTab(params['id']!);
  return new Response(null, { status: 204 });
};
