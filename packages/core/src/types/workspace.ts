/**
 * Virtual desktop (workspace) model. Mirrors Linux i3 / GNOME workspaces:
 * the global activity set is partitioned by workspace; only the active
 * workspace's members render on the desktop; switching workspaces is a
 * presentation-layer operation that never restarts an activity backend.
 *
 * Strict membership: each activity belongs to **exactly one** workspace at
 * a time (i3 semantics, the choice the user picked during planning). Moves
 * are explicit; closing an activity drops it from its owning workspace.
 *
 * Persisted in `com.aura.settings` storage via the
 * `/api/data/com.aura.settings/workspaces` content provider.
 */

export interface Workspace {
  /** Stable id, format `ws-<n>` (n monotonic). The first workspace is `ws-1`. */
  id:        string;
  /** User-visible name shown in the status bar pill and Settings. */
  name:      string;
  /** Active layout strategy id (matches `layoutRegistry.has(id)`). */
  layoutId:  string;
  /**
   * Activity ids (or instance ids for activityMode='none' apps) that
   * belong to this workspace. The shell uses this list to filter the
   * global `views` array before passing them to the layout strategy.
   */
  members:   string[];
  /**
   * Free-form persisted state owned by the layout strategy. `stack` stores
   * a `Record<viewId, {x,y,w,h,z}>` here; `tiling` ignores it. New
   * strategies pick whatever shape they need.
   */
  layoutState?: Record<string, unknown>;
}

export interface WorkspaceState {
  workspaces:        Workspace[];
  activeWorkspaceId: string;
}

/** Compact view returned by the SSE event payload (members → count only). */
export interface WorkspaceSummary {
  id:          string;
  name:        string;
  layoutId:    string;
  memberCount: number;
}

/** Default seed when no workspace state has been persisted yet. */
export const DEFAULT_WORKSPACE_STATE: WorkspaceState = {
  workspaces: [
    { id: 'ws-1', name: 'Main', layoutId: 'tiling', members: [] },
  ],
  activeWorkspaceId: 'ws-1',
};

export function toSummary(w: Workspace): WorkspaceSummary {
  return { id: w.id, name: w.name, layoutId: w.layoutId, memberCount: w.members.length };
}
