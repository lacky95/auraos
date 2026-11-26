import type { APIRoute } from 'astro';
import { liveCredentialDeps, requestCredential } from '../../../../lib/credentials.ts';

/** POST: an app or the CLI asks the owner for a credential (D56, lib/credentials.ts). */
export const POST: APIRoute = ({ request }) => requestCredential(request, liveCredentialDeps());
