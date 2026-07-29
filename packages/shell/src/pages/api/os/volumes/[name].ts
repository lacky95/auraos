import type { APIRoute } from 'astro';
import { VolumeStore } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/** DELETE /api/os/volumes/<name> — remove a Context Volume (record + data dir). */

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const DELETE: APIRoute = async ({ params }) => {
  const name = params['name'];
  if (!name || !NAME_PATTERN.test(name)) {
    return errorResponse(`invalid volume name '${name ?? ''}'`, 422);
  }
  try {
    const removed = await new VolumeStore().remove(name);
    return jsonResponse({ removed });
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
};
