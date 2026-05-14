import type { APIRoute } from 'astro';
import { buildAppDTO, jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/** Returns manifest + all running instances (with health) for an app. */
export const GET: APIRoute = async ({ params }) => {
  const appId = params['id'];
  if (!appId) return errorResponse('Missing app id', 400);
  const dto = await buildAppDTO(appId);
  if (!dto) return errorResponse(`App not found: ${appId}`, 404);
  return jsonResponse(dto);
};
