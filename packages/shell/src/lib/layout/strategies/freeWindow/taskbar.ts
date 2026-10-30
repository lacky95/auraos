/**
 * Free Window taskbar — a top-region contribution (see LayoutRegion): one
 * button per activity of the active workspace. Click: minimized → restore,
 * front activity → minimize, otherwise → bring to front.
 */
import type { LayoutHost, LayoutRegion } from '../../types.ts';

export interface TaskbarDeps {
  isFront(viewId: string): boolean;
  activate(viewId: string): void;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function createTaskbar(deps: TaskbarDeps): LayoutRegion {
  let bar: HTMLElement | null = null;
  let lastSig = '';
  const onClick = (e: MouseEvent) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('button[data-fw-view]');
    const id = btn?.dataset['fwView'];
    if (id) { e.preventDefault(); deps.activate(id); }
  };
  return {
    mount(container) {
      bar = document.createElement('div');
      bar.className = 'fw-taskbar';
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', 'Activities');
      bar.addEventListener('click', onClick);
      container.appendChild(bar);
      lastSig = '';
    },
    update(host: LayoutHost) {
      if (!bar) return;
      const items = host.views().map((v) => ({
        id: v.viewId,
        label: v.userLabel || v.title || v.appId,
        min: v.minimized,
        front: !v.minimized && deps.isFront(v.viewId),
      }));
      const sig = JSON.stringify(items);
      if (sig === lastSig) return;
      lastSig = sig;
      bar.innerHTML = items.length === 0
        ? '<span class="fw-taskbar-empty">NO ACTIVITIES</span>'
        : items.map((it) => `<button type="button" class="fw-task" data-fw-view="${esc(it.id)}"`
            + ` data-min="${it.min ? '1' : '0'}" data-front="${it.front ? '1' : '0'}"`
            + ` aria-pressed="${it.front ? 'true' : 'false'}"`
            + ` title="${esc(it.label)}${it.min ? ' (minimized)' : ''}">`
            + `<span class="fw-task-dot" aria-hidden="true"></span><span class="fw-task-label">${esc(it.label)}</span></button>`).join('');
    },
    unmount() {
      bar?.removeEventListener('click', onClick);
      bar?.remove();
      bar = null;
    },
  };
}
