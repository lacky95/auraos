/**
 * Per-layout-strategy window drag policies (see `windowDrag.ts`).
 * Keyed by layout id; unknown ids fall back to `tiling`.
 */
import * as workspaceClient from './workspaceClient';
import type { DragSource, LayoutDragPolicy } from './windowDrag';

/** Swap two windows' positions in the active workspace's `members[]` order. */
async function swapInActiveWorkspace(src: DragSource, targetViewId: string): Promise<void> {
  const state = workspaceClient.getCached();
  const ws = state?.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!ws) return;
  const members = [...ws.members];
  const a = members.indexOf(src.viewId);
  const b = members.indexOf(targetViewId);
  if (a < 0 || b < 0 || a === b) return;
  [members[a], members[b]] = [members[b]!, members[a]!];
  await workspaceClient.patchWorkspace(ws.id, { members });
}

const swap: LayoutDragPolicy = { enabled: true, slotDrop: swapInActiveWorkspace };

export const LAYOUT_DRAG_POLICIES: Record<string, LayoutDragPolicy> = {
  tiling: swap,
  rows: swap,
  columns: swap,
  // One window visible at a time: only "move to workspace" drops make sense.
  fullscreen: { enabled: true },
  // Free Window has its own title-bar move/resize drag.
  stack: { enabled: false },
};

export function dragPolicyFor(layoutId: string): LayoutDragPolicy {
  return LAYOUT_DRAG_POLICIES[layoutId] ?? LAYOUT_DRAG_POLICIES['tiling']!;
}
