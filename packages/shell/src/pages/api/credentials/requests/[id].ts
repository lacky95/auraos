import type { APIRoute } from 'astro';
import { collectCredential, liveCredentialDeps } from '../../../../lib/credentials.ts';

/** POST: the requester collects `{handle, name}` once the owner stored the secret (D56, lib/credentials.ts). */
export const POST: APIRoute = ({ params, request }) => collectCredential(request, params['id'], liveCredentialDeps());
