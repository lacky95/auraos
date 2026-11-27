/**
 * Dependency resolution: the app's `dependencies[]` (other apps it needs)
 * and its setup requirements as the resolver evaluated them
 * (`RequirementResult[]`): met, unmet (a required one: the setup cannot
 * complete) or degraded (an optional one: reported, never satisfied by
 * weakening anything, §2.4 rule 7). Inactive requirements (`when` false) do
 * not exist and are not shown.
 */
import type { DegradedRequirement, RequirementResult, SetupRequirement } from '@aura/core';
import { el, reasonList, section } from './dom.js';

/** One `dependencies[]` entry and what is installed. */
export interface AppDependencyView {
  id: string;
  /** The declared semver range. */
  version: string;
  status: 'installed' | 'missing' | 'version-mismatch';
  installedVersion?: string;
  title?: string;
}

export interface DependenciesProps {
  dependencies: readonly AppDependencyView[];
  requirements: readonly RequirementResult[];
  degraded?: readonly DegradedRequirement[];
}

export type RequirementStatus = 'met' | 'unmet' | 'degraded';

/** "feature network.isolation", "tool claude", "grant home.private". */
export function requirementLabel(r: SetupRequirement): string {
  if ('feature' in r) return `feature ${r.feature}`;
  if ('capability' in r) return `tool ${r.capability}`;
  return `grant ${r.grant}`;
}

/** met, unmet (required) or degraded (optional); null for an inactive requirement. */
export function requirementStatus(r: RequirementResult): RequirementStatus | null {
  if (r.status === 'inactive') return null;
  if (r.status === 'met') return 'met';
  return r.requirement.level === 'optional' ? 'degraded' : 'unmet';
}

const STATUS_TEXT: Record<RequirementStatus, string> = {
  met: 'met',
  unmet: 'not met: the setup cannot complete',
  degraded: 'not met (optional): the app runs with less',
};

export function renderDependencies(root: HTMLElement, props: DependenciesProps): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const s = section(doc, 'dependencies', 'Requirements');
  const ul = el(doc, 'ul', 'su-list');
  for (const d of props.dependencies) {
    const li = el(doc, 'li', 'su-item');
    li.dataset['dependency'] = d.id;
    li.dataset['status'] = d.status === 'installed' ? 'met' : 'unmet';
    li.append(el(doc, 'span', 'su-item-title', `app ${d.title ? `${d.title} (${d.id})` : d.id} ${d.version}`));
    li.append(el(doc, 'span', d.status === 'installed' ? 'su-ok' : 'su-no', d.status === 'installed'
      ? `installed${d.installedVersion ? ` (${d.installedVersion})` : ''}`
      : d.status === 'missing' ? 'not installed' : `the installed version${d.installedVersion ? ` ${d.installedVersion}` : ''} does not match ${d.version}`));
    ul.append(li);
  }
  const degradedReason = new Map((props.degraded ?? []).map((g) => [requirementLabel(g.requirement), g.reason]));
  props.requirements.forEach((r, i) => {
    const status = requirementStatus(r);
    if (!status) return;
    const label = requirementLabel(r.requirement);
    const li = el(doc, 'li', 'su-item');
    li.dataset['requirement'] = String(i);
    li.dataset['status'] = status;
    li.append(el(doc, 'span', 'su-item-title', `${label} (${r.requirement.level})`));
    li.append(el(doc, 'span', status === 'met' ? 'su-ok' : status === 'unmet' ? 'su-no' : 'su-warn', STATUS_TEXT[status]));
    if (r.requirement.reason) li.append(el(doc, 'span', 'su-item-desc', `The app says: ${r.requirement.reason}`));
    if (status === 'degraded' && degradedReason.get(label)) li.append(el(doc, 'span', 'su-item-desc', degradedReason.get(label)!));
    if (r.error) li.append(reasonList(doc, [r.error]));
    ul.append(li);
  });
  if (!ul.children.length) s.append(el(doc, 'p', 'su-note', 'Nothing else is needed.'));
  else s.append(ul);
  root.append(s);
}
