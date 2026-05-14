import type { AppRegistry } from '../app-manager/AppRegistry.js';

/**
 * MVP permission gate. The full architecture is in place — manifest declarations,
 * source-app identification, per-permission lookup — but for the MVP every check
 * resolves to `true`. Calls that WOULD have been denied in a stricter policy are
 * logged with a clear marker so we can audit before flipping the switch.
 */
export class PermissionManager {
  constructor(private readonly registry: AppRegistry) {}

  /**
   * Check whether `sourceAppId` is allowed to use `permission`.
   * - `'system'` (no source / shell-internal call) → always allowed
   * - Same-app access (sourceAppId === resourceOwnerAppId) → callers should special-case this
   * - Otherwise: looks at the source app's manifest.permissions and logs a warning if missing
   */
  hasPermission(sourceAppId: string | 'system', permission: string): boolean {
    if (sourceAppId === 'system') return true;

    const manifest = this.registry.getById(sourceAppId);
    const declared = manifest?.permissions ?? [];
    const granted  = declared.includes(permission);

    if (!granted) {
      console.warn(
        `[Permission] ${sourceAppId} requested '${permission}' (auto-granted in MVP, would deny in v2)`,
      );
    } else {
      // Quiet positive path — could turn into a debug log later
    }

    // MVP: always true. Architecture stays so the v2 swap is a one-liner.
    return true;
  }
}
