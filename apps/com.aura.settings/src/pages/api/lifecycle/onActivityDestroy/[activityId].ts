import type { APIRoute } from 'astro';

export const POST: APIRoute = ({ params }) => {
  const raw = params['activityId'];
  const id  = raw ? decodeURIComponent(raw) : undefined;
  console.log(`[settings] onActivityDestroy ${id}`);
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};
