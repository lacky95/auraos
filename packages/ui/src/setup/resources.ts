/**
 * Resources (D108 overlay `resources`, ARI `resources.limits`, D106): the
 * limits the configuration requests and whether the resolved runtime
 * enforces them. A requested limit the runtime does not enforce is a
 * refusal, never "runs without the limit": the component says so.
 * `unenforced` is the kernel's answer (`resources.limits.<key>`), not
 * computed here.
 */
import { el, section } from './dom.js';

export interface ResourcesProps {
  /** The requested limits; null: none requested. */
  requested: { memory?: string; cpus?: number } | null;
  /** The parts the runtime does not enforce (`resources.limits.cpus`, `…memoryBytes`, …). */
  unenforced: readonly string[];
  /** The runtime they were checked against. */
  runtime?: string;
}

const KEY_OF: Record<'memory' | 'cpus', string> = { memory: 'resources.limits.memoryBytes', cpus: 'resources.limits.cpus' };

export function renderResources(root: HTMLElement, props: ResourcesProps): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const s = section(doc, 'resources', 'Resources');
  const req = props.requested ?? {};
  const keys = (['memory', 'cpus'] as const).filter((k) => req[k] !== undefined);
  if (!keys.length) {
    s.append(el(doc, 'p', 'su-note', 'No limits requested: the runtime\'s defaults apply.'));
    root.append(s);
    return;
  }
  const ul = el(doc, 'ul', 'su-list');
  for (const k of keys) {
    const refused = props.unenforced.includes(KEY_OF[k]);
    const li = el(doc, 'li', 'su-item');
    li.dataset['limit'] = k;
    li.dataset['status'] = refused ? 'refused' : 'enforced';
    li.append(el(doc, 'span', 'su-item-title', k === 'memory' ? `Memory: ${req.memory}` : `CPUs: ${req.cpus}`));
    li.append(el(doc, 'span', refused ? 'su-no' : 'su-ok', refused
      ? `refused: ${props.runtime ?? 'the runtime'} cannot enforce this limit, and AuraOS never runs the app without it`
      : `enforced by ${props.runtime ?? 'the runtime'}`));
    ul.append(li);
  }
  s.append(ul);
  root.append(s);
}
