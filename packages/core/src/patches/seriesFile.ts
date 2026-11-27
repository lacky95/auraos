/**
 * The series file (`aura-patches.yaml`), checked and written without any
 * dependency (Phase 7b). PORTABLE: like `digest.ts`, `validate.ts` and
 * `apply.ts`, this module imports only `node:` builtins and types, so the
 * release builder (`os/release/series-slot.mjs`) and the installer run THIS
 * source directly with Node's type stripping, from the trusted side, before
 * anything is built: one library for the kernel and the builder (D68, D36).
 *
 * `normalizeSeriesDoc` checks a parsed document (v2, or v1 read as v2);
 * `series.ts` parses YAML for it (`parseSeries`), the builder parses JSON.
 * `formatSeriesText` writes v2 as JSON, which is YAML too: every reader
 * reads it, with or without a YAML parser.
 */
import type { PatchTarget, Series, SeriesBase, SeriesPatch } from './types.js';

export const SERIES_FILE = 'aura-patches.yaml';
export const PATCHES_DIR = 'patches';

const COMMIT_RE = /^[0-9a-f]{7,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PATCH_FILE_RE = /^patches\/[^/]+\.patch$/;

type Issue = string;
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string';

function base(doc: unknown, issues: Issue[]): SeriesBase | null {
  if (!isObj(doc)) { issues.push('base: required'); return null; }
  const out: SeriesBase = { commit: '' };
  if (doc['repository'] !== undefined) {
    if (!isStr(doc['repository']) || !doc['repository']) issues.push('base.repository: a non-empty string');
    else out.repository = doc['repository'];
  }
  if (!isStr(doc['commit']) || !COMMIT_RE.test(doc['commit'])) issues.push('base.commit: a commit hash');
  else out.commit = doc['commit'];
  if (doc['path'] !== undefined) {
    const p = doc['path'];
    if (!isStr(p) || !p || p.startsWith('/') || p.split('/').includes('..')) issues.push('base.path: a relative path');
    else out.path = p;
  }
  if (doc['release'] !== undefined) {
    if (!isStr(doc['release']) || !doc['release']) issues.push('base.release: a non-empty string');
    else out.release = doc['release'];
  }
  return out;
}

function patches(doc: unknown, issues: Issue[], v1: boolean): SeriesPatch[] {
  if (doc === undefined || doc === null) return [];
  if (!Array.isArray(doc)) { issues.push('patches: a list'); return []; }
  return doc.map((p, i) => {
    const at = `patches.${i}`;
    if (!isObj(p)) { issues.push(`${at}: an object`); return { file: '', subject: '', enabled: true }; }
    const out: SeriesPatch = { file: '', subject: '', enabled: true };
    if (!isStr(p['file']) || !PATCH_FILE_RE.test(p['file'])) issues.push(`${at}.file: patches/<name>.patch`);
    else out.file = p['file'];
    if (!isStr(p['subject'])) issues.push(`${at}.subject: a string`);
    else out.subject = p['subject'];
    if (!v1) {
      if (p['sha256'] !== undefined) {
        if (!isStr(p['sha256']) || !SHA256_RE.test(p['sha256'])) issues.push(`${at}.sha256: a sha256`);
        else out.sha256 = p['sha256'];
      }
      if (p['enabled'] !== undefined) {
        if (typeof p['enabled'] !== 'boolean') issues.push(`${at}.enabled: true or false`);
        else out.enabled = p['enabled'];
      }
    }
    return out;
  });
}

function target(doc: unknown, issues: Issue[]): PatchTarget | null {
  if (!isObj(doc)) { issues.push('target: required'); return null; }
  if (doc['kind'] === 'system') return { kind: 'system' };
  if (doc['kind'] === 'app') {
    if (!isStr(doc['appId']) || !doc['appId']) { issues.push('target.appId: required'); return null; }
    const scope = doc['scope'];
    if (scope !== undefined && scope !== 'global' && scope !== 'user') { issues.push('target.scope: global or user'); return null; }
    return { kind: 'app', appId: doc['appId'], ...(scope ? { scope } : {}) };
  }
  issues.push('target.kind: app or system');
  return null;
}

/**
 * A parsed series document as a v2 `Series`, or an Error naming every
 * problem (`<path>: <what is expected>`). A document with `v` must be v2; one
 * without is v1 (`app: <id>`, patches without sha256 or flag). Unknown keys
 * are dropped.
 */
export function normalizeSeriesDoc(doc: unknown): Series {
  const issues: Issue[] = [];
  if (!isObj(doc)) throw new Error(`${SERIES_FILE}: (root): an object`);
  let out: Series | null = null;
  if ('v' in doc) {
    if (doc['v'] !== 2) issues.push('v: 2');
    const t = target(doc['target'], issues);
    const b = base(doc['base'], issues);
    const p = patches(doc['patches'], issues, false);
    if (t && b) out = { v: 2, target: t, base: b, patches: p };
  } else {
    if (!isStr(doc['app']) || !doc['app']) issues.push('app: required');
    const b = base(doc['base'], issues);
    const p = patches(doc['patches'], issues, true);
    if (b && isStr(doc['app'])) out = { v: 2, target: { kind: 'app', appId: doc['app'] }, base: b, patches: p };
  }
  if (issues.length || !out) throw new Error(`${SERIES_FILE}: ${issues.join('; ') || 'unreadable'}`);
  return out;
}

/** The series file text: always v2, as JSON (valid YAML), keys in a fixed order. */
export function formatSeriesText(s: Series): string {
  const b: SeriesBase = {
    ...(s.base.repository ? { repository: s.base.repository } : {}),
    commit: s.base.commit,
    ...(s.base.path ? { path: s.base.path } : {}),
    ...(s.base.release ? { release: s.base.release } : {}),
  };
  const t = s.target.kind === 'app'
    ? { kind: 'app', appId: s.target.appId, ...(s.target.scope ? { scope: s.target.scope } : {}) }
    : { kind: 'system' };
  const doc = {
    v: 2, target: t, base: b,
    patches: s.patches.map((p) => ({ file: p.file, subject: p.subject, ...(p.sha256 ? { sha256: p.sha256 } : {}), enabled: p.enabled !== false })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** The series file read without a YAML parser (the builder, the installer): JSON only. */
export function parseSeriesJson(text: string): Series {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch {
    throw new Error(`${SERIES_FILE} is not in the saved form (JSON): save it with \`aura system patch save\` (or \`aura dev patch save\`)`);
  }
  return normalizeSeriesDoc(doc);
}
