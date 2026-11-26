import type { APIRoute } from 'astro';
import { getCapabilities, postCapability } from '../../../lib/capabilities.ts';

/**
 * Capability install/remove in the master's shared toolchain (SF-2,
 * lib/capabilities.ts): a request names a capability from the trusted
 * registry; the owner approves each install and remove.
 */
export const GET: APIRoute = () => getCapabilities();
export const POST: APIRoute = (ctx) => postCapability(ctx);
