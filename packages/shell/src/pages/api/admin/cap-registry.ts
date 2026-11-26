import type { APIRoute } from 'astro';
import { deleteCapabilityRegistry, getCapabilityRegistry, postCapabilityRegistry } from '../../../lib/capabilities.ts';

/**
 * The capability definitions the owner added (SF-2, lib/capabilities.ts):
 * `aura cap registry add|remove|show`. Adding or removing one needs the
 * owner's password; the entry is sealed and bound to its digest.
 */
export const GET: APIRoute = () => getCapabilityRegistry();
export const POST: APIRoute = (ctx) => postCapabilityRegistry(ctx);
export const DELETE: APIRoute = (ctx) => deleteCapabilityRegistry(ctx);
