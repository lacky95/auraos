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

// ─── Install control: one set of rules for the server render and store.ts ──

export type MainAction = 'install' | 'open' | 'update' | 'install-as';
export type MenuAction = 'open' | 'update' | 'install-copy' | 'install-as' | 'uninstall' | 'details';

export interface ControlOpts {
  /** Backed by a store entry (not just a local app). */
  catalog: boolean;
  /** Local app with a store install record: it can still update from its ref. */
  localUpdate?: boolean;
  /** Rendered on the app's own detail page (no "Details" item). */
  onDetail?: boolean;
}

export const MAIN_LABEL: Record<MainAction, string> = {
  install: 'Install', open: 'Open', update: 'Update', 'install-as': 'Install as…',
};

/** What the main button does (null while installing). */
export function mainActionOf(st: InstallState): MainAction | null {
  if (st.status === 'installing') return null;
  if (st.status === 'id-taken') return 'install-as';
  if (st.status === 'installed') return st.updateAvailable ? 'update' : 'open';
  return 'install';
}

/** Which ▾ menu items apply to this state. */
export function visibleItems(st: InstallState, o: ControlOpts): Set<MenuAction> {
  const out = new Set<MenuAction>();
  const main = mainActionOf(st);
  if (st.status === 'available') out.add('install-as');
  if (st.status === 'installed') {
    if (main !== 'open') out.add('open');
    if (main !== 'update' && (st.updateAvailable || o.localUpdate) && !st.detached) out.add('update');
    if (o.catalog) out.add('install-copy');
    if (st.canUninstall) out.add('uninstall');
  }
  if (o.catalog && !o.onDetail) out.add('details');
  return out;
}

/** The short status line under a card ("installed v1.0 · → v1.1 · built here"). */
export function statusLineOf(st: InstallState, catalogId?: string, storeVersion?: string): string {
  if (st.status === 'installing') return 'installing…';
  if (st.status === 'id-taken') return `id taken by another app (${st.localAppId})`;
  if (st.status !== 'installed') return '';
  const v = st.availableVersion ?? storeVersion;
  const parts = [`installed${st.installedVersion ? ` v${st.installedVersion}` : ''}`];
  if (st.updateAvailable && v) parts.push(`→ v${v}`);
  if (st.localAppId && catalogId && st.localAppId !== catalogId) parts.push(`as ${st.localAppId}`);
  if (st.detached) parts.push('copy');
  else if (!st.verified) parts.push('not verified');
  else if (st.scope === 'system') parts.push('system app');
  else if (!st.hasRecord) parts.push('built here');
  return parts.join(' · ');
}
