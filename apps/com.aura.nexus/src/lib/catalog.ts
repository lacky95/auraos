/** Shapes the store pages share (shell /api/nexus, /api/nexus/status). */

/** How a store entry relates to this installation — core NexusManager.installStates. */
export interface InstallState {
  status: 'available' | 'installed' | 'id-taken' | 'installing';
  localAppId?: string;
  scope?: string;
  installedVersion?: string;
  availableVersion?: string;
  updateAvailable: boolean;
  fromThisSource: boolean;
  hasRecord: boolean;
  canUninstall: boolean;
  detached: boolean;
  verified: boolean;
}

export interface CatalogEntry {
  id:           string;
  originId?:    string;
  name:         string;
  description?: string;
  icon?:        string;
  publisher?:   string;
  homepage?:    string;
  categories?:  string[];
  tags?:        string[];
  screenshots?: string[];
  version?:     string;
  longDescription?: string;
  license?:     string;
  requires?: {
    sandbox?: string; componentType?: string;
    permissions: string[]; tools: string[];
    services: Array<{ name: string; image: string }>;
    provides: Array<{ name: string; kind: string }>;
    dependencies: Array<{ appId: string; required: boolean }>;
  };
  sourceName?:  string;
  sourceKind?:  string;
  sources?:     { git?: { ref: string }; oci?: { ref: string } };
  /** Present on shells with install states; older shells only send `installed`. */
  install?:     InstallState;
  installed?:   boolean;
  installedVersion?: string | null;
  installing?:  boolean;
}

export interface SourceStatus { name: string; kind: string; ok: boolean; apps: number; error?: string }

export interface Catalog {
  schema:     number;
  apps:       CatalogEntry[];
  featured:   string[];
  categories: Array<{ slug: string; label: string }>;
  sources:    SourceStatus[];
}

/** The entry's install state, also from an older shell's `installed` flag. */
export function stateOf(e: CatalogEntry): InstallState {
  if (e.install) return e.install;
  const installed = !!e.installed;
  return {
    status: e.installing ? 'installing' : installed ? 'installed' : 'available',
    ...(installed ? { localAppId: e.id } : {}),
    ...(e.installedVersion ? { installedVersion: e.installedVersion } : {}),
    updateAvailable: false, fromThisSource: installed, hasRecord: installed,
    canUninstall: installed, detached: false, verified: installed,
  };
}

/** Facet tokens a card is filtered by (see scripts/browse.ts). */
export function facetsOf(e: CatalogEntry, st: InstallState): string {
  return [
    st.status === 'installing' ? 'installed' : st.status,
    st.updateAvailable ? 'update' : '',
    e.sourceName ? `src:${e.sourceName}` : '',
    ...(e.categories ?? []).map((c) => `cat:${c}`),
  ].filter(Boolean).join(' ');
}

/** Lower-cased text the search box matches against. */
export function searchTextOf(e: CatalogEntry): string {
  return [e.name, e.id, e.description, e.publisher, ...(e.tags ?? []), ...(e.categories ?? [])]
    .filter(Boolean).join(' ').toLowerCase();
}
