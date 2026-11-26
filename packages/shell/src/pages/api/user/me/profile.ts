import type { APIRoute } from 'astro';
import { liveUserMeDeps, patchMyProfile } from '../../../../lib/userMe.js';

/** The user changes their own profile: the desktop or Settings (D45), validated by the registry. */
export const PATCH: APIRoute = async ({ request }) => patchMyProfile(request, await liveUserMeDeps());
