import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';

/** Every live free-flight activity (the shell's flight layer boots from this). */
export const GET: APIRoute = () => {
  const mgr = core.getAppManager();
  return jsonResponse(mgr.getAllActivities()
    .filter((a) => a.presentation === 'flight')
    .map((a) => {
      const m = mgr.getManifest(a.appId);
      return {
        activityId: a.activityId, appId: a.appId, parentInstanceId: a.parentInstanceId, path: a.path,
        title: a.title ?? m?.name ?? a.appId,
        appName: m?.name ?? a.appId,
        ...(m?.icon ? { icon: m.icon } : {}),
        flight: a.flight,
      };
    }));
};
