/**
 * The `app.setup.apply` approval (D108 decision 9, P3): what the owner is
 * asked, built by the engine from the resolution, never from the
 * requester's words.
 *
 *   setupApplyPayload   the privileges the configuration adds over what the
 *                       installation holds (the resolver's missing
 *                       authorizations), bound to `configDigest` and
 *                       `grantDigest`; null when nothing privileged is added
 *                       (a plain value change needs no approval)
 *   setupApprovalItems  one line per added privilege, high-risk first: the
 *                       same wording as the wizard's preview (@aura/ui
 *                       `setup/approvalSummary.ts`) and, for the same item,
 *                       the install review (shell `installRisks`); the shell
 *                       test `setup-approval-display` keeps them equal
 *   setupApplyDisplay   the server-built dialog display
 *   askSecretDisplay    the D56 `credential.store` display of a `source: ask`
 *                       field (the shell's `credentialDisplay` wording)
 *
 * No secret, value or handle ever enters a payload, a display or an audit
 * entry: only names, digests and privilege names.
 */
import type { ApprovalDisplay, ApprovalRequester, ApprovalRisk } from '../approvals/types.js';
import type { Resolution, SetupApplyPayload, SetupErrorBody } from './contracts.js';
import type { SetupAppManifest } from './ports.js';

const HOME_PRIVATE = 'home.private';
const HOME_SIDECAR_PREFIX = 'home.private.sidecar:';

/** The `missing` keys of the resolver's unauthorized bodies (`permission:x`, `tool:x`, `context:X`, `capability:x`, a grant name). */
export function missingAuthorizations(resolution: Pick<Resolution, 'authorized'>): string[] {
  const out = new Set<string>();
  for (const b of resolution.authorized.missing) for (const m of b.missing ?? []) out.add(m);
  return [...out].sort();
}

/** Is this unauthorized body something an `app.setup.apply` approval can authorize? */
export function approvable(body: SetupErrorBody, grantable: (permission: string) => boolean): boolean {
  if (body.error !== 'requirement-unauthorized') return false;
  return (body.missing ?? []).every((m) => {
    if (m === HOME_PRIVATE || m.startsWith(HOME_SIDECAR_PREFIX)) return true;
    if (/^(permission|tool|context|capability):/.test(m)) return true;
    return grantable(m);
  });
}

const emptyAdds = (): SetupApplyPayload['adds'] => ({ permissions: [], tools: [], context: [], homePrivate: false, homePrivateSidecars: [] });

/**
 * The approval payload of a resolution, or null when it adds no privilege.
 * Networks and resources a profile changes are shown with it (they are part
 * of the bound `grantDigest`) but never make an approval necessary alone.
 */
export function setupApplyPayload(resolution: Resolution, base: SetupAppManifest): SetupApplyPayload | null {
  const adds = emptyAdds();
  const add = (list: string[], v: string) => { if (!list.includes(v)) list.push(v); };
  for (const m of missingAuthorizations(resolution)) {
    if (m === HOME_PRIVATE) adds.homePrivate = true;
    else if (m.startsWith(HOME_SIDECAR_PREFIX)) add(adds.homePrivateSidecars, m.slice(HOME_SIDECAR_PREFIX.length));
    else if (m.startsWith('permission:')) add(adds.permissions, m.slice('permission:'.length));
    else if (m.startsWith('tool:')) add(adds.tools, m.slice('tool:'.length));
    else if (m.startsWith('capability:')) add(adds.tools, m.slice('capability:'.length));
    else if (m.startsWith('context:')) add(adds.context, m.slice('context:'.length));
    else add(adds.permissions, m);
  }
  for (const l of [adds.permissions, adds.tools, adds.context, adds.homePrivateSidecars]) l.sort();
  const privileged = adds.homePrivate || adds.homePrivateSidecars.length > 0 || adds.permissions.length > 0 || adds.tools.length > 0 || adds.context.length > 0;
  if (!privileged) return null;
  const networks: Record<string, 'instance' | 'shared'> = {};
  for (const s of resolution.requested.services) {
    const was = base.services.find((b) => b.name === s.name)?.network ?? 'shared';
    if ((s.network ?? 'shared') !== was) networks[s.name] = s.network ?? 'shared';
  }
  if (Object.keys(networks).length) adds.networks = networks;
  if (resolution.requested.resources) adds.resources = { ...resolution.requested.resources };
  return {
    appId: resolution.appId, installationId: resolution.installationId, profile: resolution.profile,
    configDigest: resolution.configDigest, grantDigest: resolution.grantDigest, adds,
  };
}

// ── display (wording kept equal to @aura/ui setup/approvalSummary.ts) ───────

/** One added privilege: what, and (for a high-risk one) why it is dangerous. */
export interface SetupApprovalItem {
  key: string;
  item: string;
  why?: string;
  highRisk: boolean;
}

const PRIVATE_HOME_TEXT = 'The app can continuously use your personal home, including the credentials, logins and configuration in it, across restarts and updates. '
  + 'This needs your own approval with your password, and you can revoke it at any time: the app then stops until you approve again or choose App Home.';

const RISKY_TOOL: Record<string, [string, string]> = {
  docker: ['Tool: docker', 'Controls the container runtime, which is root on the host.'],
  '*': ['Tool: * (every tool)', 'Every tool AuraOS can provide, now and later, docker included.'],
  '#': ['Tool: # (all except the named ones)', 'Every tool AuraOS can provide except those it names, and every tool added later.'],
};

function permissionRisk(p: string): string | undefined {
  if (p === 'sidecars.privileged') return 'It may start sidecars with --privileged, added capabilities, devices or host ports.';
  if (p === 'sidecars.anyImage') return 'It may start sidecars from any image, not only its declared templates.';
  if (p.startsWith('terminal.')) return 'Access to your System Terminal: its sessions or what their screens show.';
  if (p.startsWith('notifications.')) return 'Notifications beyond its own: locked, pop-up, blocking system modals or reading other apps\' notifications (once you grant it).';
  if (p.startsWith('system.kv.os.')) return 'Writes OS-wide shared state that other apps and AuraOS read.';
  if (p === 'apps.mount') return 'It may mount other apps\' source and data into its sandbox (writable when a mount is made with --wr).';
  if (p === 'sidecars.mounts') return 'Its sidecars may get other apps\' files mounted at runtime.';
  if (p === 'apps.port') return 'It may pull other apps\' ports onto its loopback and publish its own ports on the host.';
  return undefined;
}

/** Every privilege the payload adds, one item each, high-risk first (stable order otherwise). */
export function setupApprovalItems(payload: SetupApplyPayload): SetupApprovalItem[] {
  const a = payload.adds;
  const out: SetupApprovalItem[] = [];
  const add = (key: string, item: string, why: string | undefined, highRisk: boolean): void => {
    out.push({ key, item, ...(why ? { why } : {}), highRisk });
  };
  if (a.runAsRoot) {
    add('run-as:root', 'Root execution (runAs: root)', 'It asks to run as root inside its container. Root here still has no capabilities, no Docker socket and no host access.', true);
  }
  if (a.homePrivate) add('home:private', 'Private Home', PRIVATE_HOME_TEXT, true);
  for (const s of a.homePrivateSidecars) {
    add(`home-sidecar:${s}`, `Sidecar ${s} with your Private Home`, 'The sidecar runs with your identity and can use your personal home, including its credentials.', true);
  }
  for (const t of a.tools) {
    const risk = RISKY_TOOL[t];
    add(`tool:${t}`, risk ? risk[0] : `Tool: ${t}`, risk?.[1], risk !== undefined);
  }
  for (const p of a.permissions) {
    const why = permissionRisk(p);
    add(`permission:${p}`, `Permission: ${p}`, why, why !== undefined);
  }
  for (const k of a.context) {
    add(`context:${k}`, `Context key: ${k}`, 'Approving grants it this Context key (a secret or variable); an app that holds a value can leak it.', true);
  }
  if (a.instanceScope) add('instance-scope', `Instance: ${a.instanceScope === 'shared' ? 'shared by several users' : 'your own'}`, undefined, a.instanceScope === 'shared');
  for (const [svc, net] of Object.entries(a.networks ?? {})) {
    add(`network:${svc}`, `Sidecar ${svc} network: ${net === 'instance' ? 'its instance\'s own network' : 'the shared network'}`, undefined, false);
  }
  if (a.resources && (a.resources.memory !== undefined || a.resources.cpus !== undefined)) {
    const parts = [a.resources.memory !== undefined ? `memory ${a.resources.memory}` : '', a.resources.cpus !== undefined ? `${a.resources.cpus} CPUs` : ''].filter(Boolean);
    add('resources', `Resources: ${parts.join(', ')}`, undefined, false);
  }
  return [...out.filter((i) => i.highRisk), ...out.filter((i) => !i.highRisk)];
}

/** "Terminal (com.aura.terminal-3)": the verified requester as the dialog names it (shell `requesterLabel`). */
export function setupRequesterLabel(r: ApprovalRequester, appName: (appId: string) => string | null): string {
  const name = (appId: string) => appName(appId) ?? appId;
  switch (r.kind) {
    case 'instance': return `${name(r.appId)} (${r.instanceId}${r.sidecar ? `, sidecar ${r.sidecar}` : ''})`;
    case 'user': return r.through ? `${name(r.through.appId)}, for you` : 'You, in AuraOS';
    case 'apiKey': return `API key "${r.name}"`;
  }
}

const short = (digest: string) => digest.replace(/^sha256:/, '').slice(0, 12);

/** The dialog of an `app.setup.apply` request: the facts AuraOS resolved, high-risk items first. */
export function setupApplyDisplay(payload: SetupApplyPayload, appName: string, requestedBy: string): ApprovalDisplay {
  const items = setupApprovalItems(payload);
  const highRisk: ApprovalRisk[] = items.filter((i) => i.highRisk).map((i) => ({ item: i.item, why: i.why ?? '', added: true }));
  return {
    title: `Approve the setup of ${appName}${payload.profile ? ` (profile ${payload.profile})` : ''}`,
    details: [
      ...items.filter((i) => !i.highRisk).map((i) => i.item),
      ...items.filter((i) => i.highRisk).map((i) => i.item),
      `Binds exactly this configuration (config ${short(payload.configDigest)}, privileges ${short(payload.grantDigest)}); a change needs a new approval.`,
    ],
    requestedBy,
    ...(highRisk.length ? { highRisk } : {}),
  };
}

/** The vault name of a `source: ask` secret field (a plain credential name; never `AURA_SETUP_…`, the generated ones'). */
export function askSecretName(appId: string, field: string): string {
  const f = field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  const a = (appId.split('.').pop() ?? 'APP').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return `SETUP_${a}_${f}`.slice(0, 64).replace(/_+$/, '');
}

/** The `credential.store` display (the wording of the shell's `credentialDisplay`). */
export function askSecretDisplay(ask: { name: string; for: string }, consumerName: string, requestedBy: string, fieldTitle: string): ApprovalDisplay {
  return {
    title: `Enter the secret ${ask.name}`,
    details: [
      `Used by: ${consumerName === ask.for ? ask.for : `${consumerName} (${ask.for})`}`,
      `Kept in your personal vault as ${ask.name}; an earlier value of ${ask.name} is replaced.`,
      'The app gets a handle, not the value. Reading the value needs your separate approval with your password.',
    ],
    requestedBy,
    reason: `Setup field: ${fieldTitle}`.slice(0, 200),
  };
}
