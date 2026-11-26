/**
 * `/etc/passwd` and `/etc/group` for a process context (Phase 5 stream I).
 *
 * A runtime mounts the rendered files read-only. Each entry maps a logical
 * uid from the identity registry to a name, with `pw_dir=/home/aura`: tools
 * that read the account's home (ssh, git) agree with `$HOME` (D65 §7).
 *
 * The base image's own entries are kept, except where an entry takes over a
 * name or a uid (uid 1000 is `node` in the base image; the owner's entry
 * replaces it). Rendering is pure and deterministic: the same inputs give
 * the same bytes.
 */
import { LOGICAL_HOME_PATH } from '../homes/types.js';

export interface PasswdEntry {
  name: string;
  uid: number;
  gid: number;
  /** Default `/home/aura`. */
  home?: string;
  /** Default `/bin/bash`. */
  shell?: string;
  gecos?: string;
}

export interface GroupEntry {
  name: string;
  gid: number;
  members?: readonly string[];
}

/** A field must never carry a separator or a line break. */
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/;
const FIELD_RE = /^[^:\n\r]*$/;

function assertEntry(name: string, ids: number[], fields: Array<string | undefined>): void {
  if (!NAME_RE.test(name)) throw new Error(`invalid account name '${name}'`);
  if (!ids.every((n) => Number.isSafeInteger(n) && n >= 0 && n < 2 ** 32 - 1)) throw new Error(`invalid id for '${name}'`);
  for (const f of fields) if (f !== undefined && !FIELD_RE.test(f)) throw new Error(`invalid field for '${name}'`);
}

/** The account name of an installation's app identity: `app-` and the first 12 id characters. */
export function appAccountName(installationId: string): string {
  return `app-${installationId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toLowerCase()}`;
}

function merge(base: string, taken: (cols: string[]) => boolean, lines: string[]): string {
  const kept = base.split('\n').filter((line) => {
    if (!line.trim() || line.startsWith('#')) return false;
    return !taken(line.split(':'));
  });
  return `${[...kept, ...lines].join('\n')}\n`;
}

/** The base passwd with `entries` added; an entry replaces a base line with its name or uid. */
export function renderPasswd(base: string, entries: readonly PasswdEntry[]): string {
  const names = new Set<string>();
  const uids = new Set<string>();
  const lines = [...entries].sort((a, b) => a.uid - b.uid).map((e) => {
    const home = e.home ?? LOGICAL_HOME_PATH;
    const shell = e.shell ?? '/bin/bash';
    assertEntry(e.name, [e.uid, e.gid], [home, shell, e.gecos]);
    if (names.has(e.name) || uids.has(String(e.uid))) throw new Error(`duplicate passwd entry '${e.name}' (${e.uid})`);
    names.add(e.name);
    uids.add(String(e.uid));
    return `${e.name}:x:${e.uid}:${e.gid}:${e.gecos ?? ''}:${home}:${shell}`;
  });
  return merge(base, (c) => names.has(c[0] ?? '') || uids.has(c[2] ?? ''), lines);
}

/** The base group file with `groups` added; a group replaces a base line with its name or gid. */
export function renderGroup(base: string, groups: readonly GroupEntry[]): string {
  const names = new Set<string>();
  const gids = new Set<string>();
  const lines = [...groups].sort((a, b) => a.gid - b.gid).map((gr) => {
    assertEntry(gr.name, [gr.gid], []);
    for (const m of gr.members ?? []) assertEntry(m, [0], []);
    if (names.has(gr.name) || gids.has(String(gr.gid))) throw new Error(`duplicate group '${gr.name}' (${gr.gid})`);
    names.add(gr.name);
    gids.add(String(gr.gid));
    return `${gr.name}:x:${gr.gid}:${[...(gr.members ?? [])].sort().join(',')}`;
  });
  return merge(base, (c) => names.has(c[0] ?? '') || gids.has(c[2] ?? ''), lines);
}
