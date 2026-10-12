import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';
import { checkCustomWrite, loadCustomInterfaces, parseCustomInterface, saveCustomInterfaces } from '../../../../lib/customInterfaces.js';

/**
 * User-registered external interfaces (see lib/customInterfaces.ts).
 *
 *   GET  /api/interfaces/custom   → { interfaces: CustomInterface[] }
 *   POST /api/interfaces/custom   { name, kind, address, version?, description?, schema? }
 *                                  409 when the name is taken
 */
export const GET: APIRoute = async () => {
  return jsonResponse({ interfaces: await loadCustomInterfaces() });
};

export const POST: APIRoute = async ({ request }) => {
  const denied = checkCustomWrite(request, getAppManager());
  if (denied) return errorResponse(denied, 403);
  const parsed = parseCustomInterface(await request.json().catch(() => null));
  if (!parsed.ok) return errorResponse(parsed.error, 400);

  const entries = await loadCustomInterfaces();
  if (entries.some((e) => e.name === parsed.value.name)) {
    return errorResponse(`custom interface '${parsed.value.name}' already exists`, 409);
  }
  entries.push(parsed.value);
  await saveCustomInterfaces(getAppManager(), entries);
  return jsonResponse({ ok: true, interface: parsed.value }, 201);
};
