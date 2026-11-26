import type { APIRoute } from 'astro';
import { getAppCheckout, postAppCheckout } from '../../../lib/appCheckout.ts';

/**
 * Dev checkouts of installed apps — the engine behind `aura dev checkout`
 * (lib/appCheckout.ts). GET reports; POST makes the installed app a git
 * checkout in place: the same rules as `aura dev open` (no system app, a
 * closed install opened first), then the owner's password (`fresh`), bound to
 * the app's installation and the request, used once, audited.
 */
export const GET: APIRoute = ({ url }) => getAppCheckout(url);
export const POST: APIRoute = (ctx) => postAppCheckout(ctx);
