/**
 * What the owner's approval dialog says, built only from verified server
 * data (5.10): the requester the server resolved, the install binding and
 * `PermissionDiff` core computed, or the validated payload of a write. A
 * requester's own words go in `reason` alone, which the dialog labels.
 *
 * Each action's payload is built by ONE function here, used both where the
 * approval is created and where it is consumed, so the hashes can only match
 * for the same request.
 */
import { normaliseInject } from '@aura/core';
import type { ApprovalDisplay, ApprovalLevel, ApprovalRequester, InstallBinding, PermissionDiff } from '@aura/core';

/** Tools and permissions that hand over the host or its container runtime: `fresh` (5.10). */
const RISKY_TOOLS: ReadonlySet<string> = new Set(['docker', '*']);
const RISKY_PERMISSIONS: ReadonlySet<string> = new Set(['sidecars.privileged', 'sidecars.anyImage']);

const MAX_REASON = 300;
const MAX_LINE = 400;
const clip = (s: string, n = MAX_LINE) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const list = (items: readonly string[]) => items.join(', ');

/** "Notes (com.example.notes-2)": the registry's name for a verified requester. */
export function requesterLabel(r: ApprovalRequester, appName: (appId: string) => string | null): string {
  const name = (appId: string) => appName(appId) ?? appId;
  switch (r.kind) {
    case 'instance':
      return `${name(r.appId)} (${r.instanceId}${r.sidecar ? `, sidecar ${r.sidecar}` : ''})`;
    case 'user':
      return r.through ? `${name(r.through.appId)}, for you` : 'You, in AuraOS';
    case 'apiKey':
      return `API key "${r.name}"`;
  }
}

/** `reason` as the requester wrote it: trimmed, one line, bounded. Undefined when empty. */
export function requesterReason(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  return s ? clip(s, MAX_REASON) : undefined;
}

// ── nexus.install / nexus.update ────────────────────────────────────────────

export function installLevel(binding: InstallBinding): ApprovalLevel {
  return binding.tools.some((t) => RISKY_TOOLS.has(t)) || binding.permissions.some((p) => RISKY_PERMISSIONS.has(p))
    ? 'fresh' : 'session';
}

export function installDisplay(binding: InstallBinding, diff: PermissionDiff, requestedBy: string): ApprovalDisplay {
  const update = binding.action === 'nexus.update' || diff.versionFrom !== null;
  const title = `${update ? 'Update' : 'Install'} ${binding.name} ${diff.versionFrom ? `${diff.versionFrom} → ` : ''}${binding.version}`;
  const details = [
    `App: ${binding.appId}`,
    `Scope: ${binding.scope}`,
    `Source: ${binding.source} ${binding.address}`,
    `Artifact: ${binding.digest}`,
  ];
  if (binding.identity) details.push(`Identity: ${binding.identity.action}${binding.identity.appId ? ` as ${binding.identity.appId}` : ''}`);
  if (diff.toolsAdded.length) details.push(`Tools it gains: ${list(diff.toolsAdded)}`);
  if (diff.permissionsAdded.length) details.push(`Permissions it gains: ${list(diff.permissionsAdded)}`);
  if (diff.dataProviderAdded) details.push('Exposes data other apps can read');
  if (diff.intentFiltersAdded.length) details.push(`New intent filters: ${list(diff.intentFiltersAdded)}`);
  if (diff.toolsRemoved.length) details.push(`Tools it gives up: ${list(diff.toolsRemoved)}`);
  if (diff.permissionsRemoved.length) details.push(`Permissions it gives up: ${list(diff.permissionsRemoved)}`);
  details.push(`All tools: ${binding.tools.length ? list(binding.tools) : 'none'}`);
  details.push(`All permissions: ${binding.permissions.length ? list(binding.permissions) : 'none'}`);
  if (binding.tools.includes('docker')) details.push('Warning: docker controls the container runtime, which is root on the host.');
  else if (binding.tools.includes('*')) details.push('Warning: * grants every tool AuraOS can provide.');
  if (binding.permissions.some((p) => RISKY_PERMISSIONS.has(p))) details.push('Warning: it may start privileged or arbitrary sidecar images.');
  return { title: clip(title), details: details.map((d) => clip(d)), requestedBy };
}

// ── os.context.write ────────────────────────────────────────────────────────

export const CONTEXT_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * The exact Aura Context write an approval allows. The value is a secret and
 * is not part of it: the owner approves which key changes and how it reaches
 * apps, and the record stores only a hash.
 */
export type ContextWrite =
  | { op: 'set'; key: string; kind: 'secret' | 'variable'; inject: Array<'env' | 'file'> }
  | { op: 'delete'; key: string };

/** A context write from untrusted input, normalised as the route stores it; null when invalid. */
export function contextWrite(input: unknown): ContextWrite | null {
  if (!input || typeof input !== 'object') return null;
  const { op, key, kind, inject } = input as Record<string, unknown>;
  if (typeof key !== 'string' || !CONTEXT_KEY_PATTERN.test(key)) return null;
  if (op === 'delete') return { op, key };
  if (op !== 'set') return null;
  const k = kind === undefined || kind === 'secret' ? 'secret' : kind === 'variable' ? 'variable' : null;
  if (!k) return null;
  return { op, key, kind: k, inject: normaliseInject(inject) };
}

export function contextDisplay(write: ContextWrite, requestedBy: string): ApprovalDisplay {
  if (write.op === 'delete') {
    return { title: `Delete Aura Context ${write.key}`, details: ['Apps that read it lose it at their next start.'], requestedBy };
  }
  return {
    title: `Set Aura Context ${write.key}`,
    details: [
      `Kind: ${write.kind}`,
      `Given to apps as: ${write.inject.length ? write.inject.join(' and ') : 'nothing (AuraOS only)'}`,
      'The value itself is not shown.',
    ],
    requestedBy,
  };
}

// ── user.confirm ────────────────────────────────────────────────────────────

/** The app's name for what it asks about: a short identifier, never prose. */
export const CONFIRM_ACTION_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;

export interface ConfirmPayload { action: string }

export function confirmPayload(input: unknown): ConfirmPayload | null {
  const action = (input as { action?: unknown } | null)?.action;
  return typeof action === 'string' && CONFIRM_ACTION_PATTERN.test(action) ? { action } : null;
}

export function confirmDisplay(payload: ConfirmPayload, requestedBy: string, reason?: string): ApprovalDisplay {
  return {
    title: `Confirm "${payload.action}"`,
    details: ['The app gets only your yes or no, never your password.'],
    requestedBy,
    ...(reason ? { reason } : {}),
  };
}
