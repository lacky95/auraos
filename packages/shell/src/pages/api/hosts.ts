import type { APIRoute } from 'astro';
import { jsonResponse } from '../../lib/appResponse.js';
import { listAppHosts } from '../../lib/appHosts.js';

/** GET /api/hosts → { hosts }: every app host, its URL built from the caller's host (lib/appHosts.ts). */
export const GET: APIRoute = (ctx) => jsonResponse({ hosts: listAppHosts(ctx) });
