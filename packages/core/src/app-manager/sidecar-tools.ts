import { TOOL_MARKERS, resolveToolBinaries, toolBinaryName, type SidecarMap } from './tool-allowlist.js';

/**
 * The tools an OS sidecar with its OWN allowlist dir gets (template
 * `services[].tools` ∪ runtime grants), capped at what its app holds. Pure —
 * SidecarManager reads the toolchain and provisions the result.
 *
 * Both sides are resolved to binary names first (markers `*` / `#`, helper
 * binaries that travel with their owner), then intersected. So a sidecar
 * asking for `*` gets exactly the app's set, and revoking a tool from the app
 * takes it away from every sidecar too — a sidecar never exceeds its app.
 */
export interface SidecarToolsResult {
  /** Binary names to provision into the sidecar's dir (sorted). */
  effective: string[];
  /** Named tools the sidecar asked for that its app does not hold. */
  ignored: string[];
}

export function effectiveSidecarTools(
  appTools: string[],
  templateTools: string[],
  runtimeGrants: string[],
  installedBinaries: string[],
  helperMap: SidecarMap = {},
): SidecarToolsResult {
  const app = new Set(resolveToolBinaries(appTools, installedBinaries, helperMap));
  // Template and runtime lists resolve SEPARATELY, then union: a runtime grant
  // is additive, so it must not land inside a template's `#` deny-list.
  const lists = [templateTools, runtimeGrants];
  const mine = lists.flatMap((l) => resolveToolBinaries(l, installedBinaries, helperMap));
  const effective = [...new Set(mine.filter((b) => app.has(b)))].sort();
  // In a list with a marker the named entries are exceptions (`#`) or moot
  // (`*`), not asks — only plain allow-lists can name a tool the app lacks.
  const ignored = [...new Set(lists
    .filter((l) => !l.some((t) => TOOL_MARKERS.has(t)))
    .flatMap((l) => l.filter((t) => !app.has(toolBinaryName(t)))))].sort();
  return { effective, ignored };
}

/** Tool names a grant request may carry: plain names or the two markers. */
export const SIDECAR_TOOL_RE = /^(\*|#|[A-Za-z0-9][A-Za-z0-9._+-]{0,127})$/;
