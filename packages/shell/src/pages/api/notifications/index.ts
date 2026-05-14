import type { APIRoute } from 'astro';
import { OsEventBus } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../lib/appResponse.js';

export const POST: APIRoute = async ({ request }) => {
  try {
    const { appId, title, body } = await request.json() as { appId: string; title: string; body: string };
    if (!appId || !title) return errorResponse('appId and title required', 400);
    OsEventBus.emit('notification', { appId, title, body: body ?? '' });
    return jsonResponse({ ok: true });
  } catch {
    return errorResponse('Invalid JSON', 400);
  }
};
