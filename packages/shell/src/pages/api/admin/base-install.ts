import type { APIRoute } from 'astro';
import { postBaseInstall } from '../../../lib/baseInstall.ts';

/**
 * Installs the base-rootfs essentials (or an approved package list) into the
 * running master's PRoot base-rootfs with a verified apt: lib/baseInstall.ts.
 */
export const POST: APIRoute = (ctx) => postBaseInstall(ctx);
