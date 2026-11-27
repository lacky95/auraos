import type { AppRegistry } from '../app-manager/AppRegistry.js';

/**
 * Permissions that are enforced FOR REAL, regardless of the MVP auto-grant.
 *
 * Everything else still auto-grants with a warning (see `hasPermission`), because
 * flipping the global behaviour would retroactively break every caller that has
 * been shipping against an always-true gate. This set is the migration ramp: a
 * permission moves in here once its call sites are known and the apps that need
 * it declare it in their manifest. `apps.mount` is the first with teeth — it
 * hands one app read/write access to another app's source tree, so auto-granting
 * it is not defensible.
 *
 * Phase 3: for a permission the shell's route access manifest names, the
 * auto-grant counts only outside AURA_ACCESS_ENFORCE=enforce (the shell's
 * lib/access/decide.ts `strict`). In `enforce` an app must declare it.
 */
export const ENFORCED_PERMISSIONS: readonly string[] = [
  'apps.mount',
  'apps.port',
  'sidecars.spawn',
  'sidecars.anyImage',
  'sidecars.privileged',
  'sidecars.mounts',
  'sidecars.tools',
  'sidecars.manageAll',
  // Basic notification sending (POST /api/notifications with a verified
  // instance token). Declaring it is enough.
  'system.notifications',
  // Privileged notification features: declaring them only REQUESTS them —
  // they take effect once an admin grants them (core auth `Authorizer` +
  // `GrantStore`). Listed here so this gate never auto-grants them.
  'notifications.locked',
  'notifications.popup',
  // Phase 5: reading OTHER senders' notifications (scoped by the admin grant).
  'notifications.read',
  // Phase 6: a dialogue that blocks the whole Aura shell (scope system + blocking).
  'notifications.systemModal',
  // Deprecated alias of systemModal (phase 6 rename) — same gate.
  'notifications.desktopModal',
  // The owner's System Terminal (D25, D29, 5.16): embed its sessions, list them, read their screen state.
  'terminal.embed',
  'terminal.sessions.list',
  'terminal.screen.read',
  // Owner confirmation through the shell's dialog (D49). Declaring it is enough.
  'user.confirm',
  // Ask the owner for a credential through the shell's dialog (D56). Declaring it is enough.
  'credentials.request',
  // Read another app (D104): declaring it only requests it; the owner grants it per target app.
  'apps.view',
];
const ENFORCED = new Set<string>(ENFORCED_PERMISSIONS);

/**
 * MVP permission gate. The full architecture is in place — manifest declarations,
 * source-app identification, per-permission lookup — but for the MVP every check
 * outside `ENFORCED` resolves to `true`. Calls that WOULD have been denied in a
 * stricter policy are logged with a clear marker so we can audit before flipping
 * the switch for each one.
 */
export class PermissionManager {
  constructor(private readonly registry: AppRegistry) {}

  /**
   * Check whether `sourceAppId` is allowed to use `permission`.
   * - `'system'` (no source / shell-internal call) → always allowed
   * - Same-app access (sourceAppId === resourceOwnerAppId) → callers should special-case this
   * - Otherwise: looks at the source app's manifest.permissions. Missing +
   *   ENFORCED → deny; missing + not ENFORCED → auto-grant with a warning.
   */
  hasPermission(sourceAppId: string | 'system', permission: string): boolean {
    if (sourceAppId === 'system') return true;

    const manifest = this.registry.getById(sourceAppId);
    const declared = manifest?.permissions ?? [];
    const granted  = declared.includes(permission);

    if (granted) {
      // Quiet positive path — could turn into a debug log later
      return true;
    }

    if (ENFORCED.has(permission)) {
      console.warn(
        `[Permission] DENY ${sourceAppId} → '${permission}' (not declared in manifest.permissions[])`,
      );
      return false;
    }

    console.warn(
      `[Permission] ${sourceAppId} requested '${permission}' (auto-granted in MVP, would deny in v2)`,
    );
    // MVP: always true for non-ENFORCED permissions. Architecture stays so
    // promoting the next permission is a one-line addition to ENFORCED.
    return true;
  }
}
