/**
 * Change management components (D108 P8): the change plan of a reconfigure
 * or profile change (the privileges it adds and gives up, the approval it
 * asks for, §5.5 refusals, the data that stays behind and is never copied),
 * the last applied configuration with its explicit restore (decision 13:
 * app data and outside effects are not rolled back), and the owner's own
 * Private Home grants with their revocation. Presentation only: the plain
 * views of core setup/change.ts in, the owner's actions out through
 * callbacks; Settings → Apps → Configuration and the wizard use them.
 */
import type { HomePrivateGrantView, LastAppliedView, SetupChangePlan } from '@aura/core';
import { button, el, reasonList, section } from './dom.js';
import { renderApprovalSummary } from './approvalSummary.js';

/** One privilege item (`permission:<p>`, `home:private`, `network:<svc>=<net>`, …) in words. */
export function grantItemText(key: string): string {
  const i = key.indexOf(':');
  const kind = i < 0 ? key : key.slice(0, i);
  const v = i < 0 ? '' : key.slice(i + 1);
  switch (kind) {
    case 'permission': return `Permission ${v}`;
    case 'tool': return `Tool ${v}`;
    case 'context': return `Context value ${v}`;
    case 'home': return v === 'private' ? 'Your Private Home' : 'Its own App Home';
    case 'home-sidecar': return `Sidecar ${v} with your Private Home`;
    case 'instance-scope': return v === 'shared' ? 'One instance shared by several users' : 'One instance per user';
    case 'environment-scope': return v === 'user' ? 'Your own environment' : 'The shared (global) environment';
    case 'sandbox': return `Runtime ${v}`;
    case 'network': { const [svc, net] = v.split('='); return `${svc}: ${net === 'instance' ? 'isolated instance network' : 'shared network'}`; }
    case 'resources': return `Resources ${v}`;
    default: return key;
  }
}

export interface ChangePlanProps {
  plan: SetupChangePlan;
  appName?: string;
}

/** The plan of one proposed change. Nothing here applies it: the caller's apply does, after the owner saw this. */
export function renderChangePlan(root: HTMLElement, props: ChangePlanProps): void {
  const doc = root.ownerDocument;
  const p = props.plan;
  root.replaceChildren();
  const s = section(doc, 'change', 'What changes');
  if (p.unchanged) {
    s.append(el(doc, 'p', 'su-note', 'Nothing changes: this is the configuration the app runs with.'));
    root.append(s);
    return;
  }
  if (p.valuesOnly) s.append(el(doc, 'p', 'su-note', 'Only settings change: no approval is needed.'));
  const diff = (title: string, keys: readonly string[], mark: string): void => {
    if (!keys.length) return;
    s.append(el(doc, 'p', 'su-item-title', title));
    const ul = el(doc, 'ul', 'su-list');
    for (const k of keys) {
      const li = el(doc, 'li', 'su-item', `${mark} ${grantItemText(k)}`);
      li.dataset['diff'] = `${mark === '+' ? 'added' : 'removed'}:${k}`;
      ul.append(li);
    }
    s.append(ul);
  };
  diff('It gets', p.grantDiff.added, '+');
  diff('It gives up', p.grantDiff.removed, '−');
  const reasons = [...p.compatibility, ...p.blocking];
  if (reasons.length) s.append(reasonList(doc, reasons));
  root.append(s);

  if (p.approval) {
    const a = el(doc, 'div', 'su-change-approval');
    renderApprovalSummary(a, { payload: p.approval, ...(props.appName ? { appName: props.appName } : {}) });
    root.append(a);
  }

  const b = section(doc, 'stays-behind', 'Data stays behind');
  if (p.dataStaysBehind.length) {
    const ul = el(doc, 'ul', 'su-list');
    for (const d of p.dataStaysBehind) {
      const li = el(doc, 'li', 'su-item');
      li.dataset['staysBehind'] = d.kind;
      li.append(el(doc, 'span', 'su-item-title', d.where), el(doc, 'span', 'su-item-desc', d.why));
      ul.append(li);
    }
    b.append(ul);
  }
  b.append(el(doc, 'p', 'su-note', p.note));
  root.append(b);
}

export interface LastAppliedProps {
  view: LastAppliedView | null;
  /** The restore is running or not possible right now. */
  disabled?: boolean;
}

/** The last applied configuration (names of secrets only) and the explicit restore. */
export function renderLastApplied(root: HTMLElement, props: LastAppliedProps, on: { restore(): void }): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const s = section(doc, 'last-applied', 'Last applied configuration');
  const v = props.view;
  if (!v) {
    s.append(el(doc, 'p', 'su-note', 'No configuration was applied yet.'));
    root.append(s);
    return;
  }
  s.append(el(doc, 'p', 'su-note', `Applied ${v.appliedAt}${v.profile ? ` · profile ${v.profile}` : ''}${v.current ? ' · in use now' : ''}`));
  const ul = el(doc, 'ul', 'su-list');
  for (const [k, val] of Object.entries(v.values).sort(([a], [b]) => a.localeCompare(b))) {
    ul.append(el(doc, 'li', 'su-item', `${k}: ${Array.isArray(val) ? val.join(', ') : String(val)}`));
  }
  for (const k of v.secretFields) ul.append(el(doc, 'li', 'su-item', `${k}: (secret, kept in the vault)`));
  if (ul.childElementCount) s.append(ul);
  s.append(el(doc, 'p', 'su-note', v.notice));
  const btn = button(doc, 'btn', 'RESTORE…', () => on.restore());
  btn.dataset['action'] = 'restore-last';
  btn.disabled = props.disabled === true || v.current;
  s.append(btn);
  root.append(s);
}

export interface PrivateHomeGrantsProps {
  grants: readonly HomePrivateGrantView[];
  disabled?: boolean;
}

/** The owner's own Private Home grants to this app; revoking blocks the app (it never switches to its App Home). */
export function renderPrivateHomeGrants(root: HTMLElement, props: PrivateHomeGrantsProps, on: { revoke(sidecar?: string): void }): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const s = section(doc, 'private-home', 'Your Private Home');
  if (!props.grants.length) {
    s.append(el(doc, 'p', 'su-note', 'This app has no access to your Private Home.'));
    root.append(s);
    return;
  }
  const ul = el(doc, 'ul', 'su-list');
  for (const g of props.grants) {
    const li = el(doc, 'li', 'su-item');
    li.append(el(doc, 'span', 'su-item-title', g.sidecar ? `Sidecar ${g.sidecar}` : 'The app'));
    const b = button(doc, 'btn', 'REVOKE…', () => on.revoke(g.sidecar));
    b.dataset['action'] = 'revoke-private-home';
    if (g.sidecar) b.dataset['sidecar'] = g.sidecar;
    b.disabled = props.disabled === true;
    li.append(b);
    ul.append(li);
  }
  s.append(ul, el(doc, 'p', 'su-note', 'Revoking stops the app until you allow it again or change its setup; it never switches to its own App Home by itself.'));
  root.append(s);
}
