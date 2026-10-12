import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';
import { checkCustomWrite, loadCustomInterfaces, parseCustomInterface, saveCustomInterfaces } from '../../../../lib/customInterfaces.js';

/**
 *   GET    /api/interfaces/custom/<name>  → { interface }
 *   PUT    /api/interfaces/custom/<name>  replace it (a body `name` renames)
 *   DELETE /api/interfaces/custom/<name>
 */
export const GET: APIRoute = async ({ params }) => {
  const entry = (await loadCustomInterfaces()).find((e) => e.name === params['name']);
  return entry ? jsonResponse({ interface: entry }) : errorResponse(`no custom interface '${params['name']}'`, 404);
};

export const PUT: APIRoute = async ({ params, request }) => {
  const denied = checkCustomWrite(request, getAppManager());
  if (denied) return errorResponse(denied, 403);
  const parsed = parseCustomInterface(await request.json().catch(() => null));
  if (!parsed.ok) return errorResponse(parsed.error, 400);

  const entries = await loadCustomInterfaces();
  const idx = entries.findIndex((e) => e.name === params['name']);
  if (idx < 0) return errorResponse(`no custom interface '${params['name']}'`, 404);
  if (parsed.value.name !== params['name'] && entries.some((e) => e.name === parsed.value.name)) {
    return errorResponse(`custom interface '${parsed.value.name}' already exists`, 409);
  }
  entries[idx] = parsed.value;
  await saveCustomInterfaces(getAppManager(), entries);
  return jsonResponse({ ok: true, interface: parsed.value });
};

export const DELETE: APIRoute = async ({ params, request }) => {
  const denied = checkCustomWrite(request, getAppManager());
  if (denied) return errorResponse(denied, 403);
  const entries = await loadCustomInterfaces();
  const kept = entries.filter((e) => e.name !== params['name']);
  if (kept.length === entries.length) return errorResponse(`no custom interface '${params['name']}'`, 404);
  await saveCustomInterfaces(getAppManager(), kept);
  return jsonResponse({ ok: true });
};
