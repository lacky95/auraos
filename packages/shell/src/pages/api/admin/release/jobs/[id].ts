import type { APIRoute } from 'astro';
import { getJob, liveReleaseDeps } from '../../../../../lib/release/releaseAdmin.ts';

/** `GET /api/admin/release/jobs/<id>`: one build or activation job checklist (the owner). */
export const GET: APIRoute = async ({ params }) => getJob(liveReleaseDeps(), String(params['id'] ?? ''));
