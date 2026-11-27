/**
 * The home import markers (Q15; philosophy audit #10/#11 and N1, 5b): which
 * home paths an app or a tool is likely to want, and which are a personal
 * login. Data (`os/home-import/markers.json`), never kernel code: a new app,
 * tool or agent product changes the data file, not the kernel.
 *
 * Fail closed: without a readable, valid marker file the import report and
 * the import refuse (`HomeImportMarkersError`), so a personal login is never
 * copied because its marker was missing.
 */
import { existsSync, readFileSync } from 'node:fs';

export interface HomeImportMarkers {
  /** App id → home-relative paths it uses. */
  apps: Readonly<Record<string, readonly string[]>>;
  /** Tool (capability) name → home-relative paths it keeps its state in. */
  tools: Readonly<Record<string, readonly string[]>>;
  /** Home-relative paths whose contents are a personal login (prefix match). */
  personal: readonly string[];
}

export class HomeImportMarkersError extends Error {
  override readonly name = 'HomeImportMarkersError';
  readonly code = 'import-markers-unavailable' as const;
}

/** A home-relative path: no leading slash, no `..`, no empty segment. */
const REL = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const paths = (v: unknown, at: string): string[] => {
  if (!Array.isArray(v) || !v.every((p) => typeof p === 'string' && REL.test(p))) throw new HomeImportMarkersError(`${at}: a list of home-relative paths`);
  return [...v];
};
const table = (v: unknown, at: string): Record<string, string[]> => {
  if (!isObj(v)) throw new HomeImportMarkersError(`${at}: an object`);
  return Object.fromEntries(Object.entries(v).map(([k, p]) => [k, paths(p, `${at}.${k}`)]));
};

/** The markers from untrusted JSON. Throws `HomeImportMarkersError`. */
export function parseHomeImportMarkers(raw: unknown): HomeImportMarkers {
  if (!isObj(raw)) throw new HomeImportMarkersError('the import markers are not an object');
  return Object.freeze({ apps: table(raw['apps'] ?? {}, 'apps'), tools: table(raw['tools'] ?? {}, 'tools'), personal: paths(raw['personal'], 'personal') });
}

/** Where the marker file is looked for, first match wins. */
export function homeImportMarkersCandidates(env: Record<string, string | undefined> = process.env): string[] {
  return [env['AURA_HOME_IMPORT_MARKERS'], '/os/home-import/markers.json', '/workspace/os/home-import/markers.json']
    .filter((p): p is string => !!p);
}

/** The shipped markers. Throws `HomeImportMarkersError` when none is readable or the file is invalid. */
export function loadHomeImportMarkers(env: Record<string, string | undefined> = process.env): HomeImportMarkers {
  const file = homeImportMarkersCandidates(env).find((p) => existsSync(p));
  if (!file) throw new HomeImportMarkersError('no home import marker file (os/home-import/markers.json); the import refuses rather than copy unmarked logins');
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf-8')); }
  catch (err) { throw new HomeImportMarkersError(`${file}: ${(err as Error).message}`); }
  return parseHomeImportMarkers(raw);
}

/** Whether a home-relative path is (inside) a personal login. */
export function isPersonalHomePath(rel: string, markers: Pick<HomeImportMarkers, 'personal'>): boolean {
  return markers.personal.some((p) => rel === p || rel.startsWith(`${p}/`));
}
