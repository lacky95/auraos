/**
 * `apps.view` (D104, app composition): one app's SERVER reads another app's
 * pages and read-only API for the user. One place for the decision, read by
 * the route that issues the one-time view handoff (/api/app-hosts/view,
 * src/lib/appView.ts) and by the App Host router (app-hosts.mjs), which
 * re-checks it on every request a view cookie makes.
 *
 * The grant model and the refusal texts are core's (auth/appAccess.ts): the
 * consuming app's grant of `apps.view`, scoped to the target app, pinned to
 * both installations. A view cookie names the grant it was issued under
 * (`grantedAt`), so a revoke or a new grant ends it on the next request.
 *
 * Targets are normal apps only: never a system app (or the owner's approved
 * overlay of one), a trusted system UI (D45) or an owner agent (D29) under any
 * scope, nor an app that shows the owner's Terminal sessions.
 *
 * Plain ESM: the router loads it beside the Astro build. @aura/core is
 * imported lazily; its services are globalThis singletons, so both copies
 * of this file see the same grants and apps.
 */
import { OWNER_AGENT_APPS, ownerUiApp } from './gateway-identity.mjs';

export const VIEW_PERMISSION = 'apps.view';

/** Why the shell keeps `appId` out of other apps' reach by its id, or null. */
export function appProtection(appId) {
  if (ownerUiApp(appId)) return 'it is a trusted system UI that acts for the owner (D45)';
  if (OWNER_AGENT_APPS.has(appId)) return 'it is an owner agent (D29)';
  return null;
}

/**
 * The decisions over the live system. `deps` (tests pass fakes):
 *   access                      core's appAccessTargetRefusal and appAccessCounts
 *   manifest(appId)             the app's manifest, or undefined
 *   scope(appId)                the install scope its id resolves to
 *   trustedSystemCopy(appId)    whether that copy is the system app (or its approved overlay)
 *   installation(appId)         the app's current active installation id, or null
 *   grant(consumer, target)     the consumer's `apps.view` grant record for target, or null
 *   ownerLive(userId)           whether `userId` is still the enabled owner
 */
export function createAppView(deps) {
  /** The facts a target check reads. */
  function targetFacts(appId) {
    let system = false;
    try { system = deps.trustedSystemCopy(appId) === true; } catch { system = false; }
    return { manifest: deps.manifest(appId), scope: system ? 'system' : deps.scope(appId), protectedBy: appProtection(appId) };
  }

  /** Why `target` is no target of `consumer`, as core's refusal, or null. */
  function targetRefusal(consumer, target, ctx = {}) {
    return deps.access.appAccessTargetRefusal(consumer, target, targetFacts(target), ctx);
  }

  /** Whether the consumer's manifest requests `apps.view`. */
  function declares(consumer) {
    return (deps.manifest(consumer)?.permissions ?? []).includes(VIEW_PERMISSION);
  }

  /** The consumer's install scope and current installation. */
  async function binding(appId) {
    return { scope: deps.scope(appId), installationId: await deps.installation(appId) };
  }

  /**
   * Whether a view cookie (its `view` claim) still stands for `target`
   * (`{appId, installationId}` of the host it is used on): the user is the
   * enabled owner, the consumer still requests the permission as the same
   * installation, the very grant it was issued under still counts, and the
   * target is still a target. Fails closed.
   */
  async function viewLive(view, userId, target) {
    try {
      if (!view || !(await deps.ownerLive(userId))) return false;
      if (!declares(view.by)) return false;
      const b = await binding(view.by);
      if (b.installationId !== view.byInstallation) return false;
      const rec = await deps.grant(view.by, target.appId);
      if (!rec || rec.grantedAt !== view.grantedAt) return false;
      if (!deps.access.appAccessCounts(rec, b, target.installationId)) return false;
      return targetRefusal(view.by, target.appId) === null;
    } catch {
      return false;
    }
  }

  return { targetFacts, targetRefusal, declares, binding, viewLive };
}

const core = () => import('@aura/core');

let liveView = null;
/** The decisions on the live system (lazy: core loads once). */
export async function liveAppView() {
  if (liveView) return liveView;
  const c = await core();
  const mgr = () => c.getAppManager();
  const registry = () => c.getAppHostServices().registry;
  liveView = createAppView({
    access: { appAccessTargetRefusal: c.appAccessTargetRefusal, appAccessCounts: c.appAccessCounts },
    manifest: (appId) => mgr().registry.getById(appId) ?? undefined,
    scope: (appId) => mgr().registry.getScopeId(appId) ?? undefined,
    trustedSystemCopy: (appId) => mgr().isTrustedSystemCopy(appId),
    installation: async (appId) => {
      const scope = mgr().registry.getScopeId(appId);
      if (!scope) return null;
      const i = await registry().findInstallation(appId, scope);
      return i && i.state === 'active' ? i.installationId : null;
    },
    grant: (consumer, target) => c.getAuthServices().grants.get(
      { kind: 'app', id: consumer }, VIEW_PERMISSION, { kind: 'app', id: target, installationId: '' }),
    ownerLive: async (userId) => {
      const owner = await c.getAuthServices().users.getOwner();
      return !!owner && !owner.disabled && owner.id === userId;
    },
  });
  return liveView;
}

/** A view refusal as the router answers it: core's structured error, JSON. */
export async function viewRefusalBody(code, ctx) {
  const c = await core();
  const e = c.appAccessError(code, ctx);
  return { status: e.status, body: c.appAccessErrorBody(e) };
}

/**
 * Whether a request looks like it comes from a browser: a view handoff and a
 * view cookie are for an app's server only (D104 §5), and every current
 * browser sends Fetch Metadata on navigations and subresource loads.
 */
export function browserShaped(headers) {
  return headers['sec-fetch-site'] !== undefined || headers['sec-fetch-dest'] !== undefined;
}
