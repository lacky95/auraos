/**
 * An app's declared request for privileged execution (owner decision
 * 2026-11-26, 5-main item 3): `execution: { runAs: 'root', reason }` in the
 * manifest. A REQUEST, never a grant.
 *
 *   - Only the owner's explicit approval at `fresh` grants it: the install or
 *     update approval that binds this exact config (Nexus, `InstallBinding.
 *     execution`), or the owner's `aura admin apps run-as <app> root`. The
 *     approved config is persisted on the installation (`AppInstallation.
 *     execution`: its digest, when, through what) and audited.
 *   - An update that introduces or expands it needs a new approval; one that
 *     keeps it keeps the approval (same digest); one that drops it keeps the
 *     record (the owner flips it back with `run-as app`).
 *   - Not approved, denied, changed since, or refused by the D64 option
 *     `app-root-execution`: the app is installed but does not start
 *     (`RootExecutionError`). Never a silent escalation, never a fallback.
 *
 * What it is NOT: runtime root only. It never implies privileged mode, the
 * Docker socket, a capability, a device or host access: an approved root app
 * runs as uid 0 with `--cap-drop ALL` and `no-new-privileges` (spawn/
 * identityArgs.ts). Host privileges stay with their own mechanisms (sidecar
 * templates + `sidecars.privileged`, `aura root`); temporary build privileges
 * stay in the throwaway builder (provisioning.ts). PRoot refuses root (R2).
 *
 * Legacy root (an installation with `runAs: root`, or none, and no
 * `execution` record) is the temporary 5-apps migration state, never an
 * approved root; the privilege review says so.
 *
 * Leaf contract: imports no other core module at runtime (D97).
 */
import { createHash } from 'node:crypto';

/** The manifest's `execution` block (types/manifest.ts). */
export interface ExecutionRequest {
  runAs: 'root';
  /** The app author's words. Shown labelled as such, never as AuraOS's text. */
  reason: string;
}

/** The privilege-bearing part of a request: what an approval is bound to (the reason is not). */
export interface ExecutionConfig {
  v: 1;
  runAs: 'root';
}

export type ExecutionApprovedVia = 'nexus.install' | 'nexus.update' | 'app.patch.activate' | 'admin.run-as';

/** The approved privileged execution config of one installation (`AppInstallation.execution`). */
export interface ExecutionApproval {
  runAs: 'root';
  /** `executionDigest` of the approved config. */
  digest: string;
  approvedAt: number;
  via: ExecutionApprovedVia;
}

/** The D64 switch (security/options.ts): may the owner approve a root request at all. */
export const APP_ROOT_EXECUTION_OPTION = 'app-root-execution';
export type AppRootExecutionPolicy = 'approve' | 'refuse';

export const EXECUTION_AUDIT_ACTIONS = {
  approved: 'app.execution-approved',
} as const;

/** The config a manifest requests, or null when it requests none. */
export function executionConfigOf(manifest: { execution?: { runAs?: string } | null | undefined }): ExecutionConfig | null {
  return manifest.execution?.runAs === 'root' ? { v: 1, runAs: 'root' } : null;
}

/** `sha256:<hex>` of the canonical config. */
export function executionDigest(config: ExecutionConfig): string {
  const canonical = JSON.stringify({ v: config.v, runAs: config.runAs });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/** The request as the install binding carries it: the bound digest plus the author's reason (display only). */
export interface ExecutionBinding {
  runAs: 'root';
  digest: string;
  reason: string;
  /** False when the installation already holds an approval of exactly this digest (the update keeps it). */
  renew: boolean;
}

/** What an installation has recorded (a structural subset of `AppInstallation`). */
export interface ExecutionRecord {
  runAs?: 'root' | 'app';
  execution?: ExecutionApproval;
}

/** True when this installation holds an approval of exactly this config and runs as root. */
export function executionApproved(config: ExecutionConfig, installation: ExecutionRecord | null | undefined): boolean {
  return !!installation && installation.runAs === 'root' && installation.execution?.runAs === 'root'
    && installation.execution.digest === executionDigest(config);
}

export function executionBinding(
  manifest: { execution?: { runAs?: string; reason?: string } | null | undefined },
  installation: ExecutionRecord | null | undefined,
): ExecutionBinding | null {
  const config = executionConfigOf(manifest);
  if (!config) return null;
  return {
    runAs: 'root', digest: executionDigest(config), reason: String(manifest.execution?.reason ?? ''),
    renew: !executionApproved(config, installation),
  };
}

/**
 * How an installation's app process runs, from the manifest's request and the
 * installation's record:
 *
 *   app            runAs app and no request
 *   approved-root  a request (or the owner's root) with an approval of exactly this config:
 *                  uid 0, no capabilities, no-new-privileges
 *   legacy-root    runAs root (or none) and no approval: the 5-apps migration state, unchanged
 *   refused        a request without a matching approval, or the D64 switch says `refuse`
 */
export type ExecutionDecision =
  | { kind: 'app' }
  | { kind: 'approved-root'; digest: string }
  | { kind: 'legacy-root' }
  | { kind: 'refused'; reason: 'not-approved' | 'changed' | 'policy'; message: string };

export function executionDecision(
  appId: string, config: ExecutionConfig | null, installation: ExecutionRecord, policy: AppRootExecutionPolicy,
): ExecutionDecision {
  const runAs = installation.runAs ?? 'root';
  if (config) {
    if (policy !== 'approve') {
      return { kind: 'refused', reason: 'policy', message: `${appId} requests root execution, and root execution is turned off on this AuraOS `
        + `(security option ${APP_ROOT_EXECUTION_OPTION} = refuse): root execution not approved; not started` };
    }
    if (executionApproved(config, installation)) return { kind: 'approved-root', digest: installation.execution!.digest };
    const changed = !!installation.execution && runAs === 'root';
    return {
      kind: 'refused', reason: changed ? 'changed' : 'not-approved',
      message: `${appId} requests root execution${changed ? ', and its request changed since you approved it' : ''}: `
        + 'root execution not approved; not started (never run as root without your approval). '
        + `Approve it with \`aura admin apps run-as ${appId} root\` (your password), or keep it stopped.`,
    };
  }
  if (runAs === 'app') return { kind: 'app' };
  if (installation.execution?.runAs === 'root') {
    if (policy !== 'approve') {
      return { kind: 'refused', reason: 'policy', message: `${appId} runs as approved root, and root execution is turned off on this AuraOS `
        + `(security option ${APP_ROOT_EXECUTION_OPTION} = refuse): not started` };
    }
    return { kind: 'approved-root', digest: installation.execution.digest };
  }
  return { kind: 'legacy-root' };
}

export class RootExecutionError extends Error {
  readonly code = 'root-execution-not-approved';
  constructor(readonly appId: string, readonly reason: 'not-approved' | 'changed' | 'policy', message: string) {
    super(message);
    this.name = 'RootExecutionError';
  }
}
