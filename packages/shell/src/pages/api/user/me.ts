import type { APIRoute } from 'astro';
import { getUserMe, liveUserMeDeps } from '../../../lib/userMe.js';

/** The user the caller acts for, with the profile it may read (D46). See lib/userMe.ts. */
export const GET: APIRoute = async ({ request }) => getUserMe(request, await liveUserMeDeps());
