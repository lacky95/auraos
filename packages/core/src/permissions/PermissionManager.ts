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
 */
const ENFORCED = new Set<string>(['apps.mount']);

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
