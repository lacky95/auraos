import { atom } from 'nanostores';
import type { AppView } from '@aura/core';

export const $views = atom<AppView[]>([]);

export function openView(view: AppView) {
  // De-dupe by viewId — a view should only appear once in the layout.
  const existing = $views.get().find((v) => v.viewId === view.viewId);
  if (existing) {
    focusView(existing.viewId);
    return;
  }
  $views.set([...$views.get(), { ...view, isFocused: true }]);
}

export function closeView(viewId: string) {
  $views.set($views.get().filter((v) => v.viewId !== viewId));
}

export function focusView(viewId: string) {
  $views.set($views.get().map((v) => ({ ...v, isFocused: v.viewId === viewId })));
}

export function updateViewState(instanceId: string, patch: Partial<AppView>) {
  $views.set($views.get().map((v) => (v.instanceId === instanceId ? { ...v, ...patch } : v)));
}

export function minimizeView(viewId: string) {
  $views.set($views.get().map((v) => (v.viewId === viewId ? { ...v, state: 'minimized' as const } : v)));
}
