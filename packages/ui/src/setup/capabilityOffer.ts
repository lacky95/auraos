/**
 * Capability discovery and the install / grant offer (D108 requirement
 * `{ capability }`): each capability the setup asks for, whether it is
 * installed and granted to the app, and an offer for what is missing. The
 * component never installs or grants anything itself (no `aura cap`, no
 * fetch): it hands the owner's click to the caller, which goes through the
 * capability registry and its approval.
 */
import type { RequirementLevel } from '@aura/core';
import { button, el, section } from './dom.js';

export interface CapabilityOffer {
  name: string;
  level: RequirementLevel;
  /** The app author's words (`requirements[].reason`), shown labelled. */
  reason?: string;
  installed: boolean;
  granted: boolean;
  /** Can the registry install it here? false: say so, offer nothing. */
  installable?: boolean;
}

export interface CapabilityOfferCallbacks {
  onInstall(name: string): void;
  onGrant(name: string): void;
}

export function renderCapabilityOffers(root: HTMLElement, props: { capabilities: readonly CapabilityOffer[]; disabled?: boolean }, on: CapabilityOfferCallbacks): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const s = section(doc, 'capabilities', 'Tools');
  const ul = el(doc, 'ul', 'su-list');
  for (const c of props.capabilities) {
    const li = el(doc, 'li', 'su-item');
    li.dataset['capability'] = c.name;
    const status = c.installed && c.granted ? 'ready' : !c.installed ? 'missing' : 'not-granted';
    li.dataset['status'] = status;
    li.append(el(doc, 'span', 'su-item-title', `${c.name} (${c.level})`));
    const text = status === 'ready' ? 'installed and granted to this app'
      : status === 'not-granted' ? 'installed, not granted to this app'
      : c.installable === false ? 'not installed, and AuraOS cannot install it here' : 'not installed';
    li.append(el(doc, 'span', status === 'ready' ? 'su-ok' : c.level === 'required' ? 'su-no' : 'su-warn', text));
    if (c.reason) li.append(el(doc, 'span', 'su-item-desc', `The app says: ${c.reason}`));
    if (status === 'missing' && c.installable !== false) {
      const b = button(doc, 'btn', 'INSTALL…', () => on.onInstall(c.name));
      b.dataset['action'] = 'install-capability';
      b.disabled = props.disabled === true;
      li.append(b);
    }
    if (status !== 'ready' && !(status === 'missing' && c.installable === false)) {
      const b = button(doc, 'btn', 'GRANT…', () => on.onGrant(c.name));
      b.dataset['action'] = 'grant-capability';
      b.disabled = props.disabled === true || status === 'missing';
      li.append(b);
    }
    ul.append(li);
  }
  s.append(ul);
  if (!props.capabilities.length) s.append(el(doc, 'p', 'su-note', 'This setup needs no extra tools.'));
  root.append(s);
}
