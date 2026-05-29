import type { APIRoute } from 'astro';
import { defaultKv } from '@aura/kv-store';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

const KV_KEYS: Record<string, string> = {
  global: 'scopes/global',
  user:   'scopes/users/default',
};

/**
 * PUT /api/scopes/[id]/git-repo
 * Set (or clear) the optional remote git URL for a non-system scope.
 * Body: { url: string | null }
 */
export const PUT: APIRoute = async ({ params, request }) => {
  const id = params['id'];
  if (id !== 'global' && id !== 'user') {
    return errorResponse('scope must be global or user', 400);
  }
  const body = await request.json().catch(() => ({})) as { url?: string | null };
  const url  = typeof body.url === 'string' ? body.url.trim() || null : null;

  const kv  = defaultKv();
  try {
    const key = KV_KEYS[id]!;
    const current = await kv.getValue<Record<string, unknown>>('os', key) ?? {};
    if (url === null) {
      const { gitRepo: _removed, ...rest } = current;
      await kv.set('os', key, rest);
    } else {
      await kv.set('os', key, { ...current, gitRepo: url });
    }
  } finally {
    await kv.close().catch(() => undefined);
  }

  return jsonResponse({ ok: true, scope: id, gitRepo: url });
};
