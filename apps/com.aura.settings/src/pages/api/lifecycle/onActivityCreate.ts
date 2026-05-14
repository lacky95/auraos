import type { APIRoute } from 'astro';

/**
 * Activity dispatcher. The launcher / Process Manager / other apps can pass
 * `data: { section: 'theme' | 'general' | 'about' }` to land on a specific
 * settings panel. Without it, you get the main overview.
 */
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({})) as {
    activityId?: string;
    data?: { section?: string };
  };
  const section = body.data?.section;
  let path  = '/';
  let title = 'Settings';
  switch (section) {
    case 'theme':   path = '/theme';   title = 'Settings · Theme';   break;
    case 'general': path = '/general'; title = 'Settings · General'; break;
    case 'about':   path = '/about';   title = 'Settings · About';   break;
    default:        path = '/';        title = 'Settings';
  }
  console.log(`[settings] onActivityCreate ${body.activityId} → ${path} (${title})`);
  return new Response(JSON.stringify({ path, title }), { status: 200 });
};
