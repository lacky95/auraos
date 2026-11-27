/**
 * App Home administration (Phase 5 stream H; D65 §13, Q15, D66): the owner's
 * explicit operations on App Homes. Nothing here runs implicitly.
 *
 *   importIntoAppHome    the selective copy the import report offers (Q15):
 *                        named paths from a user's home into an App Home.
 *                        Copies, never moves; the source is never changed.
 *                        A dry run (`apply: false`) is the default.
 *   resetAppHome         `aura admin homes reset`: the App Home is removed and
 *                        starts empty at the next start.
 *   deleteInstallationHomes   uninstall with `--delete-home`: every App Home of
 *                        the installation. Never a Private Home.
 *
 * Safety. The source is a user-owned home and the target an app-owned one:
 * either side may hold links planted by its owner. Every directory is opened
 * through a descriptor (`/proc/self/fd/<fd>/<name>`, `O_NOFOLLOW`), so no
 * path component is ever resolved through a symlink; symlinks and special
 * files are reported, never copied; an existing target entry is never
 * overwritten; created entries get the App Home's owner, without setuid or
 * setgid bits. Personal logins (ssh keys, Claude, gh, glab, npm tokens) are
 * copied only when the owner asks for them (D66 prefers a fresh login in the
 * app).
 */
import {
  closeSync, constants, fchmodSync, fchownSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync,
  renameSync, rmSync, writeSync,
} from 'node:fs';
import { join, posix } from 'node:path';
import { APP_HOMES_SUBPATH } from './plan.js';
import { isPersonalHomePath } from './importReport.js';
import type { LinuxIdentity } from '../identity/types.js';

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const MAX_FILES = 50_000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class AppHomeAdminError extends Error {
  constructor(readonly code: 'invalid-path' | 'unsafe' | 'not-found', message: string) {
    super(message);
    this.name = 'AppHomeAdminError';
  }
}

/** A relative home path: no `..`, no absolute path, no empty segment. */
export function normalizeHomePath(p: string): string {
  const n = posix.normalize(p.replace(/\/+$/, ''));
  if (!n || n === '.' || n.startsWith('/') || n === '..' || n.startsWith('../') || n.split('/').some((s) => s === '' || s === '..' || s === '.')) {
    throw new AppHomeAdminError('invalid-path', `not a path inside the home: ${JSON.stringify(p)}`);
  }
  return n;
}

export interface ImportItem {
  path: string;
  /** What the copy does (or did) with it. */
  action: 'copy' | 'exists' | 'missing' | 'personal' | 'unsafe';
  type?: 'file' | 'dir';
  files: number;
  bytes: number;
  /** Entries inside it left out: links, special files, existing targets, personal logins. */
  skipped: string[];
}

export interface ImportResult {
  apply: boolean;
  source: string;
  target: string;
  items: ImportItem[];
  copiedFiles: number;
  copiedBytes: number;
}

/** Opens a directory under `rootFd` by its relative path, never through a link. Null when missing. */
function openRel(rootFd: number, rel: string, create?: { owner: LinuxIdentity }): number | null {
  let fd = rootFd;
  const opened: number[] = [];
  try {
    for (const seg of rel ? rel.split('/') : []) {
      const p = `/proc/self/fd/${fd}/${seg}`;
      let next: number;
      try { next = openSync(p, DIR_FLAGS); } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' && create) {
          mkdirSync(p, { mode: 0o700 });
          next = openSync(p, DIR_FLAGS);
          fchownSync(next, create.owner.uid, create.owner.gid);
        } else if (code === 'ENOENT') { return null; } else {
          throw new AppHomeAdminError('unsafe', `${rel}: a component is a link or not a directory`);
        }
      }
      opened.push(next);
      fd = next;
    }
    const last = opened.pop();
    return last ?? -1;
  } finally { for (const o of opened) closeSync(o); }
}

interface CopyCtx {
  apply: boolean;
  owner: LinuxIdentity;
  includePersonal: boolean;
  item: ImportItem;
  budget: { files: number; bytes: number };
}

function copyFileAt(srcDirFd: number, dstDirFd: number | null, name: string, rel: string, ctx: CopyCtx): void {
  const sp = `/proc/self/fd/${srcDirFd}/${name}`;
  let src: number;
  try { src = openSync(sp, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { ctx.item.skipped.push(`${rel}: changed while copying`); return; }
  try {
    const st = fstatSync(src);
    if (!st.isFile()) { ctx.item.skipped.push(`${rel}: not a regular file`); return; }
    if (ctx.budget.files + 1 > MAX_FILES || ctx.budget.bytes + st.size > MAX_BYTES) { ctx.item.skipped.push(`${rel}: over the import limit`); return; }
    ctx.item.files++; ctx.item.bytes += st.size;
    ctx.budget.files++; ctx.budget.bytes += st.size;
    if (!ctx.apply || dstDirFd === null) return;
    let dst: number;
    try {
      dst = openSync(`/proc/self/fd/${dstDirFd}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (err) {
      ctx.item.files--; ctx.item.bytes -= st.size;
      ctx.item.skipped.push(`${rel}: ${(err as NodeJS.ErrnoException).code === 'EEXIST' ? 'already in the App Home' : 'cannot create'}`);
      return;
    }
    try {
      const buf = Buffer.allocUnsafe(1024 * 1024);
      let n: number;
      while ((n = readSync(src, buf, 0, buf.length, null)) > 0) writeSync(dst, buf, 0, n);
      fchownSync(dst, ctx.owner.uid, ctx.owner.gid);
      fchmodSync(dst, st.mode & 0o777);
    } finally { closeSync(dst); }
  } finally { closeSync(src); }
}

function copyDirAt(srcFd: number, dstFd: number | null, rel: string, ctx: CopyCtx, depth: number): void {
  if (depth > 32) { ctx.item.skipped.push(`${rel}: too deep`); return; }
  let names: string[];
  try { names = readdirSync(`/proc/self/fd/${srcFd}`).sort(); } catch { ctx.item.skipped.push(`${rel}: cannot list`); return; }
  for (const name of names) {
    const r = `${rel}/${name}`;
    if (!ctx.includePersonal && isPersonalHomePath(r)) { ctx.item.skipped.push(`${r}: a personal login (not asked for)`); continue; }
    let st;
    try { st = lstatSync(`/proc/self/fd/${srcFd}/${name}`); } catch { continue; }
    if (st.isSymbolicLink()) { ctx.item.skipped.push(`${r}: a symbolic link, not copied`); continue; }
    if (st.isFile()) { copyFileAt(srcFd, dstFd, name, r, ctx); continue; }
    if (!st.isDirectory()) { ctx.item.skipped.push(`${r}: a special file, not copied`); continue; }
    let sub: number;
    try { sub = openSync(`/proc/self/fd/${srcFd}/${name}`, DIR_FLAGS); } catch { ctx.item.skipped.push(`${r}: changed while copying`); continue; }
    try {
      let dsub: number | null = null;
      if (ctx.apply && dstFd !== null) {
        try { dsub = openRel(dstFd, name, { owner: ctx.owner }); } catch { ctx.item.skipped.push(`${r}: the App Home has something else there`); continue; }
      }
      try { copyDirAt(sub, dsub, r, ctx, depth + 1); } finally { if (dsub !== null && dsub >= 0) closeSync(dsub); }
    } finally { closeSync(sub); }
  }
}

/**
 * Copies `paths` (relative to the homes) from `source` into the App Home
 * `target` (which must exist: the Home Resolver creates it). `apply: false`
 * only measures what would be copied.
 */
export function importIntoAppHome(opts: {
  source: string; target: string; paths: readonly string[]; owner: LinuxIdentity; apply: boolean; includePersonal?: boolean;
}): ImportResult {
  const rels = [...new Set(opts.paths.map(normalizeHomePath))].sort();
  const out: ImportResult = { apply: opts.apply, source: opts.source, target: opts.target, items: [], copiedFiles: 0, copiedBytes: 0 };
  const budget = { files: 0, bytes: 0 };
  let srcRoot: number;
  try { srcRoot = openSync(opts.source, DIR_FLAGS); } catch { throw new AppHomeAdminError('not-found', 'the source home does not exist or is not a directory'); }
  let dstRoot: number | null = null;
  try {
    try { dstRoot = openSync(opts.target, DIR_FLAGS); } catch {
      if (opts.apply) throw new AppHomeAdminError('not-found', 'the App Home does not exist yet: start the app once');
    }
    for (const rel of rels) {
      const item: ImportItem = { path: rel, action: 'copy', files: 0, bytes: 0, skipped: [] };
      out.items.push(item);
      if (!opts.includePersonal && isPersonalHomePath(rel)) { item.action = 'personal'; continue; }
      const parent = posix.dirname(rel) === '.' ? '' : posix.dirname(rel);
      const name = posix.basename(rel);
      let sp: number | null;
      try { sp = openRel(srcRoot, parent); } catch { item.action = 'unsafe'; continue; }
      if (sp === null) { item.action = 'missing'; continue; }
      const spFd = sp < 0 ? srcRoot : sp;
      try {
        let st;
        try { st = lstatSync(`/proc/self/fd/${spFd}/${name}`); } catch { item.action = 'missing'; continue; }
        if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) { item.action = 'unsafe'; continue; }
        item.type = st.isDirectory() ? 'dir' : 'file';
        // An existing target is never overwritten (a file) or merged into silently (a dir: only new entries).
        let dp: number | null = null;
        if (dstRoot !== null) {
          try { dp = openRel(dstRoot, parent, opts.apply ? { owner: opts.owner } : undefined); } catch { item.action = 'unsafe'; continue; }
        }
        const dpFd = dp === null ? null : dp < 0 ? dstRoot : dp;
        try {
          let exists = false;
          if (dpFd !== null) { try { lstatSync(`/proc/self/fd/${dpFd}/${name}`); exists = true; } catch { exists = false; } }
          if (exists && item.type === 'file') { item.action = 'exists'; continue; }
          const ctx: CopyCtx = { apply: opts.apply, owner: opts.owner, includePersonal: !!opts.includePersonal, item, budget };
          if (item.type === 'file') { copyFileAt(spFd, dpFd, name, rel, ctx); continue; }
          if (exists) item.action = 'exists'; // copies only what the App Home lacks inside it
          let src: number;
          try { src = openSync(`/proc/self/fd/${spFd}/${name}`, DIR_FLAGS); } catch { item.action = 'unsafe'; continue; }
          try {
            let dsub: number | null = null;
            if (opts.apply && dpFd !== null) {
              try { dsub = openRel(dpFd, name, { owner: opts.owner }); } catch { item.action = 'unsafe'; continue; }
            }
            try { copyDirAt(src, dsub, rel, ctx, 0); } finally { if (dsub !== null && dsub >= 0) closeSync(dsub); }
          } finally { closeSync(src); }
        } finally { if (dp !== null && dp >= 0) closeSync(dp); }
      } finally { if (sp >= 0) closeSync(sp); }
    }
  } finally {
    closeSync(srcRoot);
    if (dstRoot !== null) closeSync(dstRoot);
  }
  out.copiedFiles = out.items.reduce((n, i) => n + i.files, 0);
  out.copiedBytes = out.items.reduce((n, i) => n + i.bytes, 0);
  return out;
}

/** The directory of every App Home of an installation. */
export function installationHomesDir(dataDir: string, installationId: string): string {
  if (!SEGMENT.test(installationId)) throw new AppHomeAdminError('invalid-path', 'invalid installation id');
  return join(dataDir, ...APP_HOMES_SUBPATH.split('/'), installationId);
}

/**
 * Every App Home of an installation that exists (`global`, `users/<id>`,
 * `previews/<id>`), as real directories: a symlink is never listed. The
 * run-as migration's rows (identity/runAsOwnership.ts).
 */
export function installationAppHomes(dataDir: string, installationId: string): string[] {
  const root = installationHomesDir(dataDir, installationId);
  const isDir = (p: string) => { try { const st = lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } };
  const out: string[] = [];
  if (isDir(join(root, 'global'))) out.push(join(root, 'global'));
  for (const group of ['users', 'previews']) {
    const dir = join(root, group);
    if (!isDir(dir)) continue;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { names = []; }
    for (const n of names.sort()) if (SEGMENT.test(n) && isDir(join(dir, n))) out.push(join(dir, n));
  }
  return out;
}

/** Moves `dir` out of reach in one rename, then deletes it (never following a link). False when it did not exist. */
function removeDir(dir: string): boolean {
  let st;
  try { st = lstatSync(dir); } catch { return false; }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new AppHomeAdminError('unsafe', `${dir} is not a directory`);
  const gone = `${dir}.removed-${process.pid}-${Date.now()}`;
  renameSync(dir, gone);
  rmSync(gone, { recursive: true, force: true });
  return true;
}

/** `aura admin homes reset`: the App Home `home` (a path the resolver returned) is removed; the next start creates it empty. */
export function resetAppHome(dataDir: string, home: string): boolean {
  const root = join(dataDir, ...APP_HOMES_SUBPATH.split('/'));
  if (!home.startsWith(`${root}/`)) throw new AppHomeAdminError('unsafe', 'only an App Home can be reset');
  return removeDir(home);
}

/** Uninstall with `--delete-home`: every App Home of the installation (global, per user, previews). */
export function deleteInstallationHomes(dataDir: string, installationId: string): boolean {
  return removeDir(installationHomesDir(dataDir, installationId));
}

/** Audit actions of the home operations (owner actions, `fresh`). */
export const HOME_AUDIT_ACTIONS = {
  imported: 'homes.imported',
  reset: 'homes.reset',
  deleted: 'homes.deleted',
  ownershipApplied: 'homes.ownership-applied',
  /** Stream T: the deploy's recovery: one journal of an apply restored exactly. */
  ownershipReverted: 'homes.ownership-reverted',
} as const;
