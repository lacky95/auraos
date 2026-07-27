import type { APIRoute } from 'astro';
import { json } from '../../../lib/api.ts';
import { listProjects } from '../../../lib/projects.ts';

/** The dashboard grid's data source. Re-fetched whenever the OS emits an
 *  app/instance event (see the SSE subscription in index.astro). */
export const GET: APIRoute = async () => json({ ok: true, projects: await listProjects() });
