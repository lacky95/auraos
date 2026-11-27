import type { APIRoute } from 'astro';
import { runInfraDoctor } from '@aura/core';
import { jsonResponse } from '../../../../lib/appResponse.js';
import { ownerAction } from '../../../../lib/approvals/admin.ts';

/**
 * The infrastructure doctor (D94 IC-7, O9: `aura admin infra doctor`):
 *
 *   GET [?offline=1] → { configured, ok, digest, checks: [{ id, status: ok|warn|fail|skip, message }] }
 *
 * The config, its render, the certificates, the D64 `infra-*` switches, the credential refs
 * (names only) and, unless `offline=1`, the proxy and every configured endpoint, through the
 * shell's own proxy and CA. Categories and plain words only, never a value. Read-only (a GET: no write, no approval record for the operator; `offline=1` sends nothing off the
 * host); an owner view (the operator from the host: `docker exec aura-shell aura admin infra doctor`).
 */
export const GET: APIRoute = async (ctx) => {
  const offline = ctx.url.searchParams.get('offline') === '1';
  const actor = await ownerAction(ctx, {
    action: 'admin.read', payload: { view: 'infra-doctor', offline }, level: 'session', title: 'Check the infrastructure configuration',
    details: offline ? [] : ['Contacts the configured proxy and registries'],
  });
  if (actor instanceof Response) return actor;
  return jsonResponse(await runInfraDoctor({ network: !offline }));
};
