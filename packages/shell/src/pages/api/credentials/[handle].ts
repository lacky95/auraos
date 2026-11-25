import type { APIRoute } from 'astro';
import { liveCredentialDeps, readCredential } from '../../../lib/credentials.ts';

/**
 * GET /api/credentials/<handle> — `osClient.credentials.get` (D56): the value,
 * to the consuming app's own server, only with the owner's
 * `credential.read:<NAME>` grant (202 needs-approval, `fresh`, until then).
 * lib/credentials.ts.
 */
export const GET: APIRoute = ({ params, request }) => readCredential(request, params['handle'], liveCredentialDeps());
