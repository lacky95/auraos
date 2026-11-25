import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { checkPermissions } from '../../../../lib/appContract.ts';
import { permissionHeld } from '../../../../lib/access/decide.ts';
import { accessMode } from '../../../../../server/access-mode.mjs';

/**
 * `osClient.permissions.has/check` (D48): which of `?p=<permission>` the
 * calling app holds now, decided as a route rule decides it (manifest, the
 * owner's grants; in `enforce` an auto-grant doesn't count). See lib/appContract.ts.
 */
export const GET: APIRoute = async ({ request }) => {
  const { resolveCaller } = await import('../../../../lib/auth.ts');
  const authorizer = core.getAuthServices().authorizer;
  return checkPermissions(request, {
    resolve: (r) => resolveCaller(r),
    held: (principal, permission) => permissionHeld({ authorizer }, principal, permission, accessMode() === 'enforce'),
  });
};
