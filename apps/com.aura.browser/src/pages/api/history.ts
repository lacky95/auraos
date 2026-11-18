import type { APIRoute } from 'astro';
import { getHistory, recordVisit, deleteHistory } from '../../lib/browse-store';
import { rankEntries } from '../../lib/omnibox';
import { json, guard, body } from '../../lib/json';

// Browsing history. GET ?q= ranks like the address bar (newest first without
// q); POST {url,title} records a visit; DELETE clears all, or one ?url=.
export const GET: APIRoute = ({ url }) => guard(async () => {
  const q = url.searchParams.get('q') ?? '';
  const limit = Math.min(Number(url.searchParams.get('limit')) || 2000, 2000);
  const all = await getHistory();
  return json({ history: q ? rankEntries(q, all, limit) : all.slice(0, limit) });
});

export const POST: APIRoute = ({ request }) => guard(async () => {
  const b = await body(request);
  if (typeof b.url !== 'string' || !/^https?:/i.test(b.url)) return json({ error: 'url required' }, 400);
  await recordVisit(b.url, typeof b.title === 'string' ? b.title.slice(0, 500) : '');
  return json({ ok: true });
});

export const DELETE: APIRoute = ({ url }) => guard(async () => {
  await deleteHistory(url.searchParams.get('url') ?? undefined);
  return json({ ok: true });
});
