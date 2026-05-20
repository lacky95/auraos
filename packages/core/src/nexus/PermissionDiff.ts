/**
 * Compute the permission/tool/intent diff between the currently-installed
 * manifest (or null on first install) and the incoming one. Pure function —
 * same input always yields the same output. Both the CLI prompt and the
 * Nexus app's approval modal render the returned struct verbatim so the
 * "what's about to change" view stays identical across surfaces.
 */
import type { AppManifest } from '../types/manifest.js';
import type { PermissionDiff } from './types.js';

export function computePermissionDiff(
  current: AppManifest | null,
  next:    AppManifest,
): PermissionDiff {
  const currentTools = new Set(current?.tools ?? []);
  const nextTools    = new Set(next.tools);
  const currentPerms = new Set(current?.permissions ?? []);
  const nextPerms    = new Set(next.permissions);

  const toolsAdded   = [...nextTools].filter((t) => !currentTools.has(t)).sort();
  const toolsRemoved = [...currentTools].filter((t) => !nextTools.has(t)).sort();
  const permissionsAdded   = [...nextPerms].filter((p) => !currentPerms.has(p)).sort();
  const permissionsRemoved = [...currentPerms].filter((p) => !nextPerms.has(p)).sort();

  const dataProviderAdded   = !current?.dataProvider && !!next.dataProvider;
  const dataProviderRemoved = !!current?.dataProvider && !next.dataProvider;

  // Intent filters: only show ADDED, not removed (removing one shouldn't
  // surprise the user — they're losing a capability, not gaining one).
  const currentFilters = new Set(
    (current?.intentFilters ?? []).map(intentFilterKey),
  );
  const intentFiltersAdded = (next.intentFilters ?? [])
    .filter((f) => !currentFilters.has(intentFilterKey(f)))
    .map(intentFilterLabel);

  return {
    appId:        next.id,
    versionFrom:  current?.version ?? null,
    versionTo:    next.version,
    toolsAdded,
    toolsRemoved,
    permissionsAdded,
    permissionsRemoved,
    dataProviderAdded,
    dataProviderRemoved,
    intentFiltersAdded,
  };
}

/** Internal identity key for intent filters: action + sorted MIME + sorted scheme. */
function intentFilterKey(f: {
  action: string;
  dataMime: string[];
  dataScheme: string[];
}): string {
  const mime   = [...f.dataMime].sort().join(',');
  const scheme = [...f.dataScheme].sort().join(',');
  return `${f.action}|${mime}|${scheme}`;
}

/** Human-readable single-line label for an intent filter. */
function intentFilterLabel(f: {
  action: string;
  dataMime: string[];
  dataScheme: string[];
}): string {
  const parts = [f.action];
  if (f.dataMime.length)   parts.push(`mime=[${f.dataMime.join(',')}]`);
  if (f.dataScheme.length) parts.push(`scheme=[${f.dataScheme.join(',')}]`);
  return parts.join(' ');
}

/**
 * Does this diff require user approval? On first install: always
 * (everything is new). On update: only when something is genuinely added
 * — tool, permission, data provider, or intent filter. Removals never
 * gate (they're a capability shrink).
 */
export function diffRequiresApproval(diff: PermissionDiff): boolean {
  // First install: versionFrom is null → user has never approved anything
  // about this app, ask now.
  if (diff.versionFrom === null) {
    return diff.toolsAdded.length > 0
        || diff.permissionsAdded.length > 0
        || diff.dataProviderAdded
        || diff.intentFiltersAdded.length > 0;
  }
  return diff.toolsAdded.length > 0
      || diff.permissionsAdded.length > 0
      || diff.dataProviderAdded
      || diff.intentFiltersAdded.length > 0;
}

/**
 * Plain-text renderer for the diff. Reused by the CLI prompt. The GUI
 * modal renders the same data structure with its own component instead
 * of consuming this string.
 */
export function renderDiffPlainText(diff: PermissionDiff): string {
  const lines: string[] = [];
  const v = diff.versionFrom
    ? `${diff.versionFrom} → ${diff.versionTo}`
    : diff.versionTo;
  lines.push(`Install ${diff.appId} (${v})`);
  lines.push('');
  if (diff.toolsAdded.length)   lines.push(`NEW TOOLS:        + ${diff.toolsAdded.join(', + ')}`);
  if (diff.toolsRemoved.length) lines.push(`REMOVED TOOLS:    - ${diff.toolsRemoved.join(', - ')}`);
  if (diff.permissionsAdded.length)   lines.push(`NEW PERMISSIONS:  + ${diff.permissionsAdded.join(', + ')}`);
  if (diff.permissionsRemoved.length) lines.push(`REMOVED PERMS:    - ${diff.permissionsRemoved.join(', - ')}`);
  if (diff.dataProviderAdded)   lines.push('EXPOSES DATA PROVIDER (new)');
  if (diff.dataProviderRemoved) lines.push('DROPS DATA PROVIDER');
  if (diff.intentFiltersAdded.length) {
    lines.push('NEW INTENT FILTERS:');
    for (const f of diff.intentFiltersAdded) lines.push(`  + ${f}`);
  }
  return lines.join('\n');
}
