import type { APIRoute } from 'astro';
import { readAction } from '../../../lib/runtimeActions.ts';

/** Debug helper: the PRoot binary in use, its version, and a smoke test against the base rootfs (the PRoot module's `info` action). */
export const GET: APIRoute = () => readAction('proot', 'info');
