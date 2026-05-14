import type { APIRoute } from 'astro';
import { buildInstanceDTO, jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

export const GET: APIRoute = async ({ params }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);
  const dto = await buildInstanceDTO(instanceId);
  if (!dto) return errorResponse(`Instance not found: ${instanceId}`, 404);
  return jsonResponse(dto);
};
