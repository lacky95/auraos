import type { APIRoute } from 'astro';
import { readAction } from '../../../lib/runtimeActions.ts';

/** Debug: the base rootfs size and a sample of its dirs (the PRoot module's `inspectRootfs` action). */
export const GET: APIRoute = () => readAction('proot', 'inspectRootfs');
