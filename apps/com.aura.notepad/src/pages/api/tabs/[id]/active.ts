import type { APIRoute } from 'astro';
import { setActiveTab, sseSnapshot } from '../../../../state.js';

export const PUT: APIRoute = ({ params }) => {
  setActiveTab(params['id']!);
  return new Response(JSON.stringify(sseSnapshot()), { headers: { 'Content-Type': 'application/json' } });
};
