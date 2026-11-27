import type { APIRoute } from 'astro';
import { getStatus, liveReleaseDeps } from '../../../../lib/release/releaseAdmin.ts';

/**
 * `GET /api/admin/release` (Phase 6 U): the current and previous release, the
 * channel, provenance, the held state, snapshots and the last job. The owner
 * (D29: the trusted Terminal too). See lib/release/releaseAdmin.ts.
 */
export const GET: APIRoute = async () => getStatus(liveReleaseDeps());
