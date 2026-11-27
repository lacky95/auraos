/**
 * Patch contracts (D68, Phase 7): what a series targets, what an approval of
 * an activation binds, and the audit actions of the patch lifecycle. Shared by
 * the app patch engine (`aura dev patch`, the install pipeline) and the system
 * patch engine (Phase 7b). A contract leaf: no runtime import of any module.
 */

/** What a series changes: one app installation, or AuraOS itself (7b). */
export type PatchTarget =
  | { kind: 'app'; appId: string; scope?: 'global' | 'user' }
  | { kind: 'system' };

/**
 * What an approval of a patch activation binds (Q23, D68 "approval
 * integrity"): the base, the exact series revision and content, its order
 * and its disabled patches. Any change is a new binding, so a consumed
 * approval of the old one never covers it.
 */
export interface PatchBinding {
  target: PatchTarget;
  /** The upstream commit the series applies to (full hash). */
  baseCommit: string;
  /** The patch repository commit holding the series. */
  seriesRev: string;
  /** `seriesDigest()`: target, base and every patch's sha256 + enabled flag, in order. */
  seriesDigest: string;
  /** Per-patch sha256 of the enabled patches, in apply order. */
  order: string[];
  /** Per-patch sha256 of the disabled patches, in series order. */
  disabled: string[];
  /** The release composition a system series is validated for (7b, D73). */
  composition?: string;
}

/** Audit actions of the patch lifecycle (AdminAudit; never patch contents). */
export const PATCH_AUDIT_ACTIONS = {
  saved: 'patch.saved',
  activated: 'patch.activated',
  activationFailed: 'patch.activation-failed',
  rolledBack: 'patch.rolled-back',
  needsRepair: 'patch.needs-repair',
  disabled: 'patch.disabled',
  enabled: 'patch.enabled',
} as const;
export type PatchAuditAction = (typeof PATCH_AUDIT_ACTIONS)[keyof typeof PATCH_AUDIT_ACTIONS];

/** One finding of `validatePatch`: refused (the patch is rejected) or flagged (shown in the approval). */
export interface PatchFinding {
  severity: 'refuse' | 'flag';
  code:
    | 'path-escape' | 'absolute-path' | 'git-internal' | 'submodule' | 'series-file' | 'symlink-escape'
    | 'file-too-large' | 'patch-too-large' | 'trust-anchor' | 'unreadable'
    | 'binary' | 'mode-change' | 'image-file' | 'dependencies';
  path?: string;
  message: string;
}

/** Limits of `validatePatch` (defaults in validate.ts). */
export interface PatchLimits {
  /** Largest added content of one file, bytes. */
  maxFileBytes: number;
  /** Largest patch file, bytes. */
  maxPatchBytes: number;
}
