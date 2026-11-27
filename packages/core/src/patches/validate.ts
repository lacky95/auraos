/**
 * Per-patch validation (D68 "validate before activate", Phase 7 L): reads the
 * headers of a `git format-patch` file and its diff headers only (nothing is
 * executed or applied) and decides what is refused and what the approval
 * must show. Run on save, on import and before every apply (series.ts).
 *
 * Refused: a path that leaves the tree (`..`, absolute), anything under
 * `.git/`, `.gitmodules` or a gitlink (mode 160000), the series' own files at
 * the tree root, a symlink pointing out of the tree, a file or patch over the
 * limits, and for the system target the release trust anchor (D71: keys and
 * verifier are never changed locally).
 * Flagged: binary hunks, mode changes, image inputs (`Dockerfile`, new files
 * under `os/`), dependency manifests and lockfiles.
 */
import { posix } from 'node:path';
import type { PatchFinding, PatchLimits, PatchTarget } from './types.js';

export const DEFAULT_PATCH_LIMITS: PatchLimits = { maxFileBytes: 2 * 1024 * 1024, maxPatchBytes: 8 * 1024 * 1024 };

/** Paths of the system tree a local patch never changes (D71 trust anchor). */
export const SYSTEM_TRUST_ANCHORS = ['os/release-keys/', 'os/release-verify.mjs'] as const;

const DEPENDENCY_FILES = new Set(['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'npm-shrinkwrap.json', 'pnpm-workspace.yaml']);

export interface PatchFile {
  /** Path after the change (before it, for a deletion). */
  path: string;
  /** Path before the change when it differs (rename, copy). */
  from?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';
  oldMode?: string;
  newMode?: string;
  binary: boolean;
  /** Bytes of added lines. */
  addedBytes: number;
  /** A new or changed symlink's target (mode 120000). */
  symlinkTarget?: string;
}

export interface PatchValidation {
  ok: boolean;
  refused: PatchFinding[];
  flags: PatchFinding[];
  files: PatchFile[];
}

/** Unquote a git path (`"a/x\tb"` with C escapes) and drop its a/ or b/ prefix. */
function gitPath(raw: string): string | null {
  let p = raw.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('"') && p.endsWith('"')) {
    const bytes: number[] = [];
    const s = p.slice(1, -1);
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      if (c !== '\\') { bytes.push(...Buffer.from(c, 'utf8')); continue; }
      const n = s[++i]!;
      if (/[0-7]/.test(n)) { bytes.push(parseInt(s.slice(i, i + 3), 8)); i += 2; continue; }
      bytes.push(({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 } as Record<string, number>)[n] ?? n.charCodeAt(0));
    }
    p = Buffer.from(bytes).toString('utf8');
  }
  return p.replace(/^[ab]\//, '');
}

/** The files a patch touches, from its diff headers. */
export function patchFiles(content: string): PatchFile[] {
  const files: PatchFile[] = [];
  let cur: PatchFile | null = null;
  let inHunk = false;
  let symlink = false;
  for (const line of content.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      let a: string | null = null, b: string | null = null;
      const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest);
      if (quoted) { a = gitPath(quoted[1]!); b = gitPath(quoted[2]!); }
      else {
        // Unquoted with spaces: `a/<p> b/<p>`, both halves equal.
        const half = (rest.length - 1) / 2;
        a = gitPath(rest.slice(0, half)); b = gitPath(rest.slice(half + 1));
      }
      cur = { path: b ?? a ?? '', ...(a && b && a !== b ? { from: a } : {}), status: 'modified', binary: false, addedBytes: 0 };
      files.push(cur);
      inHunk = false; symlink = false;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (inHunk) {
      if (line.startsWith('+')) {
        cur.addedBytes += Buffer.byteLength(line, 'utf8');
        if (symlink && cur.symlinkTarget === undefined) cur.symlinkTarget = line.slice(1);
      }
      if (line.startsWith('-- ') || line === '--') inHunk = false; // format-patch signature separator
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^new file mode (\d+)/.exec(line))) { cur.status = 'added'; cur.newMode = m[1]!; symlink = m[1] === '120000'; }
    else if ((m = /^deleted file mode (\d+)/.exec(line))) { cur.status = 'deleted'; cur.oldMode = m[1]!; }
    else if ((m = /^old mode (\d+)/.exec(line))) cur.oldMode = m[1]!;
    else if ((m = /^new mode (\d+)/.exec(line))) { cur.newMode = m[1]!; symlink = m[1] === '120000'; }
    else if ((m = /^index [0-9a-f]+\.\.[0-9a-f]+ (\d+)/.exec(line))) { cur.oldMode ??= m[1]; cur.newMode ??= m[1]; symlink = symlink || m[1] === '120000'; }
    else if ((m = /^rename from (.*)$/.exec(line))) { cur.from = gitPath(m[1]!) ?? undefined; cur.status = 'renamed'; }
    else if ((m = /^rename to (.*)$/.exec(line))) { cur.path = gitPath(m[1]!) ?? cur.path; cur.status = 'renamed'; }
    else if ((m = /^copy from (.*)$/.exec(line))) { cur.from = gitPath(m[1]!) ?? undefined; cur.status = 'copied'; }
    else if ((m = /^copy to (.*)$/.exec(line))) { cur.path = gitPath(m[1]!) ?? cur.path; cur.status = 'copied'; }
    else if ((m = /^--- (.*)$/.exec(line))) { const p = gitPath(m[1]!); if (p && cur.status !== 'added') cur.from = p !== cur.path ? p : cur.from; }
    else if ((m = /^\+\+\+ (.*)$/.exec(line))) { const p = gitPath(m[1]!); if (p) cur.path = p; }
    else if (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch') cur.binary = true;
  }
  return files;
}

/** All paths a series touches (both sides of renames), sorted, for component mapping (7b V). */
export function touchedPaths(patches: Array<{ content: string }>): string[] {
  const out = new Set<string>();
  for (const p of patches) for (const f of patchFiles(p.content)) { out.add(f.path); if (f.from) out.add(f.from); }
  return [...out].sort();
}

function pathProblem(p: string): PatchFinding['code'] | null {
  if (!p) return 'unreadable';
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return 'absolute-path';
  const parts = p.split('/');
  if (parts.some((s) => s === '..' || s === '\0')) return 'path-escape';
  if (parts.some((s) => s === '.git')) return 'git-internal';
  if (parts[parts.length - 1] === '.gitmodules') return 'submodule';
  if (p === 'aura-patches.yaml' || parts[0] === 'patches' && parts.length > 1 && p.endsWith('.patch')) return 'series-file';
  return null;
}

/**
 * Validate one patch file for `target`. Never throws; an unreadable patch
 * (no diff at all, while it is not empty) is refused.
 */
export function validatePatch(content: string, ctx: { target: PatchTarget; limits?: Partial<PatchLimits> }): PatchValidation {
  const limits = { ...DEFAULT_PATCH_LIMITS, ...ctx.limits };
  const refused: PatchFinding[] = [];
  const flags: PatchFinding[] = [];
  const refuse = (code: PatchFinding['code'], message: string, path?: string) => refused.push({ severity: 'refuse', code, message, ...(path ? { path } : {}) });
  const flag = (code: PatchFinding['code'], message: string, path?: string) => flags.push({ severity: 'flag', code, message, ...(path ? { path } : {}) });

  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > limits.maxPatchBytes) refuse('patch-too-large', `the patch is ${bytes} bytes (limit ${limits.maxPatchBytes})`);
  const files = patchFiles(content);
  if (!files.length && /^diff /m.test(content)) {
    refuse('unreadable', 'the diff headers could not be read');
  }
  for (const f of files) {
    for (const p of [f.path, ...(f.from ? [f.from] : [])]) {
      const problem = pathProblem(p);
      if (problem) {
        const what = { 'absolute-path': 'an absolute path', 'path-escape': 'a path that leaves the tree', 'git-internal': 'git internals',
          submodule: 'submodules', 'series-file': 'the patch series itself', unreadable: 'an unreadable path' } as Record<string, string>;
        refuse(problem, `${p}: changes ${what[problem] ?? problem}`, p);
      }
      if (ctx.target.kind === 'system' && SYSTEM_TRUST_ANCHORS.some((a) => (a.endsWith('/') ? p.startsWith(a) : p === a))) {
        refuse('trust-anchor', `${p}: the release trust anchor is never changed by a local patch (D71)`, p);
      }
    }
    if (f.newMode === '160000' || f.oldMode === '160000') refuse('submodule', `${f.path}: a gitlink (submodule)`, f.path);
    if (f.symlinkTarget !== undefined) {
      const t = f.symlinkTarget;
      const resolved = posix.normalize(posix.join(posix.dirname(f.path), t));
      if (t.startsWith('/') || resolved === '..' || resolved.startsWith('../')) refuse('symlink-escape', `${f.path}: a symlink to ${t}, outside the tree`, f.path);
    }
    if (f.addedBytes > limits.maxFileBytes) refuse('file-too-large', `${f.path}: ${f.addedBytes} bytes added (limit ${limits.maxFileBytes})`, f.path);
    if (f.binary) flag('binary', `${f.path}: binary content (not shown as text)`, f.path);
    if (f.oldMode && f.newMode && f.oldMode !== f.newMode && f.status !== 'added') flag('mode-change', `${f.path}: mode ${f.oldMode} → ${f.newMode}`, f.path);
    else if (f.status === 'added' && f.newMode === '100755') flag('mode-change', `${f.path}: a new executable file`, f.path);
    const base = f.path.split('/').pop()!;
    if (f.path === 'Dockerfile' || /^Dockerfile\./.test(f.path) || (f.status === 'added' && f.path.startsWith('os/'))) {
      flag('image-file', `${f.path}: changes what the image is built from`, f.path);
    }
    if (DEPENDENCY_FILES.has(base)) flag('dependencies', `${f.path}: changes dependencies`, f.path);
  }
  return { ok: refused.length === 0, refused, flags, files };
}
