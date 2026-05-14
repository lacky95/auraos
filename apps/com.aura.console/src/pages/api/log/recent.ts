import type { APIRoute } from 'astro';
import { tailLogFile } from '../../../log-server';

export const GET: APIRoute = ({ url }) => {
  const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit') ?? '500') || 500));
  return new Response(JSON.stringify({ entries: tailLogFile(limit) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
