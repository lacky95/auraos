/**
 * The approval summary (D108 decision 9): what `app.setup.apply` asks the
 * owner to approve, from the server-built payload (`SetupApplyPayload.adds`,
 * never the requester's words). Every added privilege is one line; the
 * high-risk ones come first under HIGH RISK, like the owner's approval
 * dialog (OwnerPasswordDialog), with the same wording as the install review
 * (shell lib/approvals/display.ts `installRisks`) where the item is the same.
 * The approval itself is the shell's dialog: this is the preview in the
 * wizard's review step and Settings → Apps → Configuration.
 */
import type { SetupApplyPayload } from '@aura/core';
import { el, section } from './dom.js';
import { HOME_TEXT } from './homeSelector.js';

/** One added privilege: what, and (for a high-risk one) why it is dangerous. */
export interface SetupApprovalItem {
  /** `permission:<p>`, `tool:<t>`, `context:<k>`, `home:private`, `home-sidecar:<n>`, `instance-scope`, `network:<svc>`, `resources`, `run-as:root`. */
  key: string;
  item: string;
  why?: string;
  highRisk: boolean;
}

// The install review's wording (display.ts installRisks) for the same items.
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
  if (a.homePrivate) add('home:private', 'Private Home', HOME_TEXT.private.text, true);
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

/**
 * Does the owner approve it with the password? The Private Home, a home
 * sidecar or root: the same parts as core `setupApplyClass` (setup/contracts.ts;
 * parity tested). Shown only; the server decides the class.
 */
export function setupApprovalNeedsPassword(payload: SetupApplyPayload): boolean {
  const a = payload.adds;
  return a.homePrivate === true || a.homePrivateSidecars.length > 0 || a.runAsRoot === true;
}

export interface ApprovalSummaryProps {
  /** The plan's `approval`; null: nothing privileged is added. */
  payload: SetupApplyPayload | null;
  /** The app's name for the title (the registry's; falls back to the id). */
  appName?: string;
}

export function renderApprovalSummary(root: HTMLElement, props: ApprovalSummaryProps): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const s = section(doc, 'approval', 'Your approval');
  const p = props.payload;
  if (!p) {
    s.append(el(doc, 'p', 'su-note', 'This setup adds no privileges: no approval is needed.'));
    root.append(s);
    return;
  }
  s.append(el(doc, 'p', 'su-approval-title', `Approve the setup of ${props.appName ?? p.appId}${p.profile ? ` (profile ${p.profile})` : ''}`));
  const items = setupApprovalItems(p);
  const risky = items.filter((i) => i.highRisk);
  const list = (cls: string, of: SetupApprovalItem[]): HTMLUListElement => {
    const ul = el(doc, 'ul', cls);
    for (const i of of) {
      const li = el(doc, 'li', 'su-item');
      li.dataset['add'] = i.key;
      if (i.highRisk) li.dataset['risk'] = 'high';
      li.append(el(doc, 'span', i.highRisk ? 'su-risk-item' : 'su-item-title', i.item));
      if (i.why) li.append(el(doc, 'span', 'su-item-desc', i.why));
      ul.append(li);
    }
    return ul;
  };
  if (risky.length) {
    const box = el(doc, 'div', 'su-risk');
    box.dataset['highRisk'] = '';
    box.append(el(doc, 'div', 'su-risk-title', 'HIGH RISK'), list('su-list', risky));
    s.append(box);
  }
  const rest = items.filter((i) => !i.highRisk);
  if (rest.length) s.append(list('su-list', rest));
  if (!items.length) s.append(el(doc, 'p', 'su-note', 'It adds no new privileges; the approval binds this exact configuration.'));
  const how = el(doc, 'p', 'su-note', setupApprovalNeedsPassword(p)
    ? 'AuraOS asks you to approve this with your password when you apply.'
    : 'AuraOS asks you to approve this when you apply.');
  how.dataset['needsPassword'] = String(setupApprovalNeedsPassword(p));
  s.append(how);
  root.append(s);
}
