/**
 * Storage (read-only display): the volumes the configuration uses, where
 * they are mounted and what happens to them. Data never moves with a
 * profile or home change (D65 §14, D107 §3.4): the caller lists what stays
 * behind in `staysBehind`.
 */
import { el, section } from './dom.js';

export interface StorageVolumeView {
  name: string;
  /** Where the app sees it. */
  mountPath?: string;
  /** e.g. 'app data', 'App Home', 'Private Home', 'shared volume'. */
  kind: string;
  readOnly?: boolean;
  sizeBytes?: number;
}

export interface StorageProps {
  volumes: readonly StorageVolumeView[];
  /** Data that stays where it is after this change (never copied automatically). */
  staysBehind?: readonly string[];
}

function size(n: number): string {
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${i ? v.toFixed(1) : v} ${u[i]}`;
}

export function renderStorage(root: HTMLElement, props: StorageProps): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const s = section(doc, 'storage', 'Storage');
  const ul = el(doc, 'ul', 'su-list');
  for (const v of props.volumes) {
    const li = el(doc, 'li', 'su-item');
    li.dataset['volume'] = v.name;
    li.append(el(doc, 'span', 'su-item-title', `${v.name} · ${v.kind}`));
    const facts = [v.mountPath ? `at ${v.mountPath}` : '', v.readOnly ? 'read-only' : '', v.sizeBytes !== undefined ? size(v.sizeBytes) : '']
      .filter(Boolean).join(' · ');
    if (facts) li.append(el(doc, 'span', 'su-item-desc', facts));
    ul.append(li);
  }
  if (!props.volumes.length) s.append(el(doc, 'p', 'su-note', 'No volumes.'));
  else s.append(ul);
  if (props.staysBehind?.length) {
    const p = el(doc, 'p', 'su-note su-warn', `Stays where it is (not copied): ${props.staysBehind.join(', ')}`);
    p.dataset['staysBehind'] = '';
    s.append(p);
  }
  root.append(s);
}
