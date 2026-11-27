import type { APIRoute } from 'astro';
import { liveSetupSelfDeps, readSetupSelf } from '../../../lib/setupSelf.ts';

/**
 * GET (instance token): the calling app's own effective setup values
 * (SetupConfigView, D108); secrets as D56 handles. lib/setupSelf.ts.
 */
export const GET: APIRoute = ({ request }) => readSetupSelf(request, liveSetupSelfDeps());
