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
import { isCredentialName, normaliseInject, SENSITIVE_APPS } from '@aura/core';
import type { ApprovalDisplay, ApprovalLevel, ApprovalRequester, ApprovalRisk, InstallBinding, PermissionDiff } from '@aura/core';

/** Tools and permissions that hand over the host or its container runtime: `fresh` (5.10). */
const RISKY_TOOLS: ReadonlySet<string> = new Set(['docker', '*']);
const RISKY_PERMISSIONS: ReadonlySet<string> = new Set(['sidecars.privileged', 'sidecars.anyImage']);

/** A tool whose grant needs the password (D9): docker, or every tool. */
export const isRiskyTool = (tool: string): boolean => RISKY_TOOLS.has(tool);
/** A permission that lets an app start privileged or arbitrary sidecar images. */
export const isRiskyPermission = (permission: string): boolean => RISKY_PERMISSIONS.has(permission);

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

/**
 * The high-risk review of an install or update (owner decision 5-main item 3):
 * every item the manifest and the binding can ask for that hands over root,
 * the host, secrets, the owner's Terminal, other apps or the network. One
 * server-built line each (never the requester's wording); any one of them
 * makes the approval `fresh`. The table is in phase5-rootreq-progress.md and
 * docs/approvals: keep the three in step.
 */
export function installRisks(binding: InstallBinding, diff: PermissionDiff): ApprovalRisk[] {
  const out: ApprovalRisk[] = [];
  const newInstall = diff.versionFrom === null;
  const toolAdded = (t: string) => newInstall || diff.toolsAdded.includes(t);
  const permAdded = (p: string) => newInstall || diff.permissionsAdded.includes(p);
  const add = (item: string, why: string, added: boolean) => out.push({ item, why, added });

  const ex = binding.execution;
  if (ex) {
    add('Root execution (runAs: root)',
      ex.renew
        ? 'It asks to run as root inside its container. Approving grants exactly this request to this installation; '
          + 'without it the app is installed but does not start. Root here still has no capabilities, no Docker socket and no host access.'
        : 'It keeps the root execution you approved for this installation (same config). Still no capabilities, no Docker socket, no host access.',
      ex.renew);
  }
  if (SENSITIVE_APPS.has(binding.appId)) {
    add(`Sensitive app id ${binding.appId}`, 'A copy under this id shadows a built-in app that holds owner powers (Settings, Terminal, Nexus).', newInstall);
  }
  for (const t of binding.tools ?? []) {
    if (t === 'docker') add('Tool: docker', 'Controls the container runtime, which is root on the host.', toolAdded(t));
    else if (t === '*') add('Tool: * (every tool)', 'Every tool AuraOS can provide, now and later, docker included.', toolAdded(t));
    else if (t === '#') add('Tool: # (all except the named ones)', 'Every tool AuraOS can provide except those it names, and every tool added later.', toolAdded(t));
  }
  for (const p of binding.permissions ?? []) {
    if (p === 'sidecars.privileged') add(`Permission: ${p}`, 'It may start sidecars with --privileged, added capabilities, devices or host ports.', permAdded(p));
    else if (p === 'sidecars.anyImage') add(`Permission: ${p}`, 'It may start sidecars from any image, not only its declared templates.', permAdded(p));
    else if (p.startsWith('terminal.')) add(`Permission: ${p}`, 'Access to your System Terminal: its sessions or what their screens show.', permAdded(p));
    else if (p.startsWith('notifications.')) add(`Permission: ${p}`, 'Notifications beyond its own: locked, pop-up, blocking system modals or reading other apps\' notifications (once you grant it).', permAdded(p));
    else if (p.startsWith('system.kv.os.')) add(`Permission: ${p}`, 'Writes OS-wide shared state that other apps and AuraOS read.', permAdded(p));
    else if (p === 'apps.mount') add(`Permission: ${p}`, 'It may mount other apps\' source and data into its sandbox (writable when a mount is made with --wr).', permAdded(p));
    else if (p === 'sidecars.mounts') add(`Permission: ${p}`, 'Its sidecars may get other apps\' files mounted at runtime.', permAdded(p));
    else if (p === 'apps.port') add(`Permission: ${p}`, 'It may pull other apps\' ports onto its loopback and publish its own ports on the host.', permAdded(p));
  }
  if ((binding.context ?? []).length) {
    const added = newInstall ? binding.context : (diff.contextAdded ?? []);
    add(`Context secrets: ${list(binding.context)}`, 'Approving grants it these Context keys (secrets and variables); an app that holds a value can leak it.', added.length > 0);
  }
  const x = binding.exposure;
  for (const sc of x?.sidecars ?? []) {
    const what = [
      sc.privileged ? '--privileged' : '', sc.capabilities.length ? `capabilities ${list(sc.capabilities)}` : '',
      sc.devices.length ? `devices ${list(sc.devices)}` : '', sc.publish.length ? `host ports ${list(sc.publish)}` : '',
      sc.dockerSocket ? 'the Docker socket' : '', sc.root ? 'as the image\'s root' : '',
    ].filter(Boolean).join(', ');
    add(`Sidecar ${sc.name} (${sc.image})`, `A sidecar template with ${what}: host privileges beyond an app container.`, newInstall);
  }
  if (x?.hostPublish.length) add(`Host ports: ${x.hostPublish.join(', ')}`, 'Publishes its ports on the host (127.0.0.1) at every start.', newInstall);
  if (x?.portExposes.length) add(`Other apps' ports: ${list(x.portExposes)}`, 'Pulls these apps\' ports onto its loopback at every start.', newInstall);
  return out;
}

/** Any high-risk item, or a Context grant, needs the password (D9, 5-main item 3). */
export function installLevel(binding: InstallBinding, diff: PermissionDiff): ApprovalLevel {
  return installRisks(binding, diff).length > 0 || (binding.context ?? []).length > 0 ? 'fresh' : 'session';
}

export function installDisplay(binding: InstallBinding, diff: PermissionDiff, requestedBy: string): ApprovalDisplay {
  const update = binding.action === 'nexus.update' || diff.versionFrom !== null;
  const title = binding.action === 'app.patch.activate'
    ? `Activate patched ${binding.name} ${binding.version}${binding.scope === 'user' && diff.versionFrom === null ? ' (as your own copy)' : ''}`
    : `${update ? 'Update' : 'Install'} ${binding.name} ${diff.versionFrom ? `${diff.versionFrom} → ` : ''}${binding.version}`;
  const details = [
    `App: ${binding.appId}`,
    `Scope: ${binding.scope}`,
    `Source: ${binding.source} ${binding.address}`,
    `Artifact: ${binding.digest}`,
  ];
  if (binding.replaceCheckout) details.push(`Replaces your dev checkout of ${binding.appId} (uncommitted work is lost)`);
  if (binding.action === 'app.patch.activate') {
    details.push('Replaces the installed source with this prepared tree; the previous tree is kept for rollback.');
  }
  if (binding.identity) details.push(`Identity: ${binding.identity.action}${binding.identity.appId ? ` as ${binding.identity.appId}` : ''}`);
  if (binding.execution) details.push(`Root execution request: ${binding.execution.digest}${binding.execution.renew ? ' (needs your approval now)' : ' (already approved)'}`);
  if (diff.toolsAdded.length) details.push(`Tools it gains: ${list(diff.toolsAdded)}`);
  if (diff.permissionsAdded.length) details.push(`Permissions it gains: ${list(diff.permissionsAdded)}`);
  if (diff.dataProviderAdded) details.push('Exposes data other apps can read');
  if (diff.intentFiltersAdded.length) details.push(`New intent filters: ${list(diff.intentFiltersAdded)}`);
  if ((diff.contextAdded ?? []).length) details.push(`Context keys it may read (granted with this approval): ${list(diff.contextAdded)}`);
  if (diff.toolsRemoved.length) details.push(`Tools it gives up: ${list(diff.toolsRemoved)}`);
  if (diff.permissionsRemoved.length) details.push(`Permissions it gives up: ${list(diff.permissionsRemoved)}`);
  details.push(`All tools: ${binding.tools.length ? list(binding.tools) : 'none'}`);
  details.push(`All permissions: ${binding.permissions.length ? list(binding.permissions) : 'none'}`);
  if ((binding.context ?? []).length) details.push(`All Context keys: ${list(binding.context)}`);
  const risks = installRisks(binding, diff);
  // The app author's words for its root request: only as the labelled reason, never as AuraOS's text.
  const reason = binding.execution ? requesterReason(binding.execution.reason) : undefined;
  return {
    title: clip(title), details: details.map((d) => clip(d)), requestedBy,
    ...(risks.length ? { highRisk: risks.map((r) => ({ item: clip(r.item, 160), why: clip(r.why), added: r.added })) } : {}),
    ...(reason ? { reason } : {}),
  };
}

// ── app.patch.activate / app.source.open (Track P, D9) ──────────────────────

/**
 * An app patch: one click, but the password for a sensitive app (Settings,
 * Terminal, Nexus), for a patch that changes the app's tools or permissions,
 * and for Docker or every tool.
 */
export function patchLevel(appId: string, binding: InstallBinding, diff: PermissionDiff): ApprovalLevel {
  const changes = diff.toolsAdded.length + diff.toolsRemoved.length + diff.permissionsAdded.length + diff.permissionsRemoved.length
    + (diff.contextAdded ?? []).length > 0;
  return SENSITIVE_APPS.has(appId) || changes ? 'fresh' : installLevel(binding, diff);
}

/** Opening an app's source: one click, the password for a sensitive app. */
export const sourceOpenLevel = (appId: string): ApprovalLevel => (SENSITIVE_APPS.has(appId) ? 'fresh' : 'session');

export function sourceOpenDetails(appId: string, scope: string): string[] {
  return [
    `App: ${appId} (${scope} scope)`,
    'Its installed source becomes writable to agents and the Terminal (`aura mount --wr`, `aura dev checkout`).',
    'Updates no longer go through patches you can review; close it again with `aura dev close`.',
  ];
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

// ── terminal.agent-hooks ────────────────────────────────────────────────────

export interface AgentHooksChange { op: 'install' | 'remove' }

export function agentHooksDisplay(change: AgentHooksChange, requestedBy: string): ApprovalDisplay {
  return {
    title: change.op === 'install' ? 'Install the Terminal\'s agent hooks' : 'Remove the Terminal\'s agent hooks',
    details: [
      'Changes ~/.claude/settings.json and ~/.codex/config.toml in your home, which every app shares (each file is backed up first).',
      change.op === 'install'
        ? 'Claude Code and Codex then report what they do to the Terminal session they run in.'
        : 'Only the Terminal\'s own entries go.',
    ],
    requestedBy,
  };
}

// ── admin.* (D50): the owner's management routes ────────────────────────────

/** What an owner-management request shows: its own title and facts, built by the route from what it validated. */
export function adminDisplay(title: string, details: readonly string[], requestedBy: string): ApprovalDisplay {
  return { title: clip(title), details: details.map((d) => clip(d)), requestedBy };
}

// ── credential.store / credential.read (D56) ────────────────────────────────

/**
 * The exact credential request an approval allows: which name, for which
 * consuming app. The value is not part of it; the owner types it into the
 * shell's dialog, and the approve request carries it straight to the vault.
 */
export interface CredentialAsk { name: string; for: string }

const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function credentialAsk(input: unknown): CredentialAsk | null {
  if (!input || typeof input !== 'object') return null;
  const { name, for: consumer } = input as Record<string, unknown>;
  if (!isCredentialName(name) || typeof consumer !== 'string' || !APP_ID_RE.test(consumer)) return null;
  return { name, for: consumer };
}

/** What the dialog says: the verified requester and consuming app; label and purpose only as the labelled reason. */
export function credentialDisplay(ask: CredentialAsk, consumerName: string, requestedBy: string, reason?: string): ApprovalDisplay {
  return {
    title: `Enter the secret ${ask.name}`,
    details: [
      `Used by: ${consumerName === ask.for ? ask.for : `${consumerName} (${ask.for})`}`,
      `Kept in your personal vault as ${ask.name}; an earlier value of ${ask.name} is replaced.`,
      'The app gets a handle, not the value. Reading the value needs your separate approval with your password.',
    ],
    requestedBy,
    ...(reason ? { reason } : {}),
  };
}

/** The exact raw read an approval allows: one app, one credential. */
export interface CredentialRead { name: string; app: string }

export function credentialReadDisplay(read: CredentialRead, appName: string, requestedBy: string): ApprovalDisplay {
  return {
    title: `Let ${appName} read the secret ${read.name}`,
    details: [
      `App: ${read.app}`,
      'It gets the value itself, on its server, until you revoke it in Settings → Users & Identities → Secrets.',
      'An app that holds a value can leak it.',
    ],
    requestedBy,
  };
}
