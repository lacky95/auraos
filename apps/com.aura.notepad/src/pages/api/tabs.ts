import type { APIRoute } from 'astro';
import { createTab, tabsSnapshot } from '../../state.js';

export const GET: APIRoute = () =>
  new Response(JSON.stringify(tabsSnapshot()), { headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = () => {
  const tab = createTab();
  return new Response(JSON.stringify(tab), { status: 201, headers: { 'Content-Type': 'application/json' } });
};
