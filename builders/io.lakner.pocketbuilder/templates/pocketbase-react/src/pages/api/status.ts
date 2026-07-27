import type { APIRoute } from 'astro';
import { pbStatus } from '../../lib/pocketbase.ts';

/** Live PocketBase state — polled by the index page and by Pocket Builder. */
export const GET: APIRoute = async () => {
  const status = await pbStatus();
  return new Response(JSON.stringify(status), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
