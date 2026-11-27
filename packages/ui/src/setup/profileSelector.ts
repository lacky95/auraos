/**
 * The operating-profile selector (D108 §2.3, decision 3): every profile the
 * setup API lists (`ProfileOption[]`), the recommended one badged, an
 * unavailable one disabled with its D105 reasons. Nothing is picked for the
 * owner: with no `selected`, no profile is checked, recommended or not, and
 * an unavailable profile can never be selected (not even when `selected`
 * names it).
 */
import type { ProfileOption } from '@aura/core';
import { el, reasonList, section } from './dom.js';

export interface ProfileSelectorProps {
  profiles: readonly ProfileOption[];
  /** The owner's choice so far (the desired record or this wizard run); null: none yet. */
  selected: string | null;
  disabled?: boolean;
}

export interface ProfileSelectorCallbacks {
  /** The owner picked an available profile. */
  onSelect(profileId: string): void;
}

export function renderProfileSelector(root: HTMLElement, props: ProfileSelectorProps, on: ProfileSelectorCallbacks): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const s = section(doc, 'profiles', 'Operating profile');
  const list = el(doc, 'div', 'su-options');
  list.setAttribute('role', 'radiogroup');
  for (const p of props.profiles) {
    const opt = el(doc, 'label', p.available ? 'su-option' : 'su-option su-unavailable');
    opt.dataset['profile'] = p.id;
    opt.dataset['available'] = String(p.available);
    const radio = el(doc, 'input');
    radio.type = 'radio';
    radio.name = 'su-profile';
    radio.value = p.id;
    radio.disabled = !p.available || props.disabled === true;
    radio.checked = p.available && props.selected === p.id;
    radio.addEventListener('change', () => { if (radio.checked && p.available) on.onSelect(p.id); });
    const head = el(doc, 'span', 'su-option-title', p.title);
    if (p.recommended) {
      const badge = el(doc, 'span', 'su-badge', 'recommended');
      badge.dataset['recommended'] = '';
      head.append(' ', badge);
    }
    if (!p.available) head.append(' ', el(doc, 'span', 'su-badge su-badge-off', 'unavailable'));
    opt.append(radio, head);
    if (p.description) opt.append(el(doc, 'span', 'su-option-desc', p.description));
    if (!p.available && p.reasons.length) opt.append(reasonList(doc, p.reasons));
    list.append(opt);
  }
  if (!props.profiles.length) list.append(el(doc, 'p', 'su-note', 'This app has no operating profiles.'));
  s.append(list);
  if (props.profiles.length && !props.profiles.some((p) => p.available)) {
    s.append(el(doc, 'p', 'su-note su-no', 'No profile can run on this AuraOS now. The reasons are listed with each profile.'));
  }
  root.append(s);
}
