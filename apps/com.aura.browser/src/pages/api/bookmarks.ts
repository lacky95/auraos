import type { APIRoute } from 'astro';
import { getBookmarks, addBookmark, renameBookmark, deleteBookmark } from '../../lib/browse-store';
import { json, guard, body } from '../../lib/json';

// Bookmarks bar data. POST {url,title} adds (idempotent per url); PUT
// {id,title} renames; DELETE ?id= removes.
export const GET: APIRoute = () => guard(async () => json({ bookmarks: await getBookmarks() }));

export const POST: APIRoute = ({ request }) => guard(async () => {
  const b = await body(request);
  if (typeof b.url !== 'string' || !/^https?:/i.test(b.url)) return json({ error: 'url required' }, 400);
  return json({ bookmark: await addBookmark(b.url, typeof b.title === 'string' ? b.title.slice(0, 500) : '') });
});

export const PUT: APIRoute = ({ request }) => guard(async () => {
  const b = await body(request);
  if (typeof b.id !== 'string' || typeof b.title !== 'string') return json({ error: 'id and title required' }, 400);
  return json({ bookmarks: await renameBookmark(b.id, b.title.slice(0, 500)) });
});

export const DELETE: APIRoute = ({ url }) => guard(async () => {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);
  await deleteBookmark(id);
  return json({ ok: true });
});
