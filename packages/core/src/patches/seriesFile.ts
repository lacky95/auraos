/**
 * The series file (`aura-patches.json`, and the old `aura-patches.yaml`), checked and written without any
 * dependency (Phase 7b). PORTABLE: like `digest.ts`, `validate.ts` and
 * `apply.ts`, this module imports only `node:` builtins and types, so the
 * release builder (`os/release/series-slot.mjs`) and the installer run THIS
 * source directly with Node's type stripping, from the trusted side, before
 * anything is built: one library for the kernel and the builder (D68, D36).
 *
 * The file (owner 2026-11-27): `aura-patches.json`, v2, written as JSON by
 * every save. The old `aura-patches.yaml` (Track P v1 and 7a v2, written by
 * the `yaml` package) is still READ: the kernel and the CLI parse it with the
 * full YAML parser (`series.ts`), the builder and the installer with
 * `parseSavedYaml` below, a small reader for exactly the subset those saves
 * produced. The next save of a repository writes `aura-patches.json` and
 * removes `aura-patches.yaml` in the same commit (the one-time migration).
 *
 * `normalizeSeriesDoc` checks a parsed document (v2, or v1 read as v2).
 */
import type { PatchTarget, Series, SeriesBase, SeriesPatch } from './types.js';

export const SERIES_FILE = 'aura-patches.json';
/** The series file before 7b (YAML): read, never written; the next save migrates it. */
export const LEGACY_SERIES_FILE = 'aura-patches.yaml';
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

export const SAVED_FORM_HINT = `save the series once with \`aura system patch save\` (or \`aura dev patch save\`), which writes ${SERIES_FILE}, `
  + `or write ${SERIES_FILE} yourself: JSON with v: 2, target, base { commit }, patches [{ file, subject, sha256, enabled }] (Docs: System patches)`;

/** The series file read without a YAML library (the builder, the installer): `.json`, or the old saved YAML form. */
export function parseSeriesFile(name: string, text: string): Series {
  let doc: unknown;
  if (name === SERIES_FILE) {
    try { doc = JSON.parse(text); } catch (e) { throw new Error(`${SERIES_FILE} is not valid JSON (${(e as Error).message}): ${SAVED_FORM_HINT}`); }
  } else {
    try { doc = parseSavedYaml(text); } catch (e) {
      throw new Error(`${LEGACY_SERIES_FILE} is not in the form AuraOS saves (${(e as Error).message}): ${SAVED_FORM_HINT}`);
    }
  }
  return normalizeSeriesDoc(doc);
}

/** @deprecated name: `parseSeriesFile(SERIES_FILE, text)`. */
export const parseSeriesJson = (text: string): Series => parseSeriesFile(SERIES_FILE, text);

// ─── the old saved YAML form ────────────────────────────────────────────────
//
// What `yaml.stringify` wrote for a series (Track P v1 and 7a v2): block
// mappings and sequences (2-space indent, `- key: value` items), `[]`/`{}`,
// plain, single- and double-quoted scalars, the quoted and plain ones folded
// over several lines (continuation lines indented deeper), `#` comments.
// Anything else (anchors, tags, block scalars, flow collections with content)
// is refused: such a file was not written by AuraOS.

interface Line { indent: number; text: string; no: number }

const fail = (no: number, what: string): never => { throw new Error(`line ${no}: ${what}`); };

function decodeDouble(raw: string, no: number): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c !== '\\') { out += c; continue; }
    const n = raw[++i];
    const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v', ' ': ' ', N: '\u0085', _: '\u00a0' };
    if (n === undefined) fail(no, 'a dangling escape');
    if (simple[n!] !== undefined) { out += simple[n!]; continue; }
    const len = n === 'x' ? 2 : n === 'u' ? 4 : n === 'U' ? 8 : 0;
    if (!len) fail(no, `an unknown escape \\${n}`);
    const hex = raw.slice(i + 1, i + 1 + len);
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) fail(no, 'a bad escape');
    out += String.fromCodePoint(parseInt(hex, 16));
    i += len;
  }
  return out;
}

/** Folds the lines of a multi-line flow scalar: one line break → a space, an empty line → a newline. */
function fold(parts: string[]): string {
  if (parts.length === 1) return parts[0]!;
  let out = '';
  let pendingBreaks = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = i === 0 ? parts[i]!.replace(/[ \t]+$/, '') : i === parts.length - 1 ? parts[i]!.replace(/^[ \t]+/, '') : parts[i]!.trim();
    if (i > 0 && p === '' && i < parts.length - 1) { pendingBreaks++; continue; }
    if (i > 0) out += pendingBreaks ? '\n'.repeat(pendingBreaks) : ' ';
    pendingBreaks = 0;
    out += p;
  }
  return out;
}

/** A scalar that starts at `first` (the text after `key: ` or `- `), with its continuation lines. */
function scalar(first: string, more: Line[], no: number): unknown {
  const q = first[0];
  if (q === '"' || q === "'") {
    const parts = [first.slice(1)];
    for (const l of more) parts.push(l.text);
    let body = parts.join('\n');
    // The closing quote: the last unescaped one (double) / not doubled (single).
    if (q === '"') {
      let end = -1;
      for (let i = 0; i < body.length; i++) { if (body[i] === '\\') { i++; continue; } if (body[i] === '"') { end = i; break; } }
      if (end < 0) fail(no, 'an unterminated double-quoted string');
      if (body.slice(end + 1).trim() && !body.slice(end + 1).trim().startsWith('#')) fail(no, 'text after a quoted string');
      body = body.slice(0, end);
      // `\` at a line end joins without a space.
      const lines = body.split('\n');
      const joined: string[] = [];
      for (const l of lines) {
        if (joined.length && /(^|[^\\])(\\\\)*\\$/.test(joined[joined.length - 1]!)) { joined[joined.length - 1] = joined[joined.length - 1]!.slice(0, -1) + l.replace(/^[ \t]+/, ''); continue; }
        joined.push(l);
      }
      return decodeDouble(fold(joined), no);
    }
    let end = -1;
    for (let i = 0; i < body.length; i++) { if (body[i] === "'") { if (body[i + 1] === "'") { i++; continue; } end = i; break; } }
    if (end < 0) fail(no, 'an unterminated single-quoted string');
    if (body.slice(end + 1).trim() && !body.slice(end + 1).trim().startsWith('#')) fail(no, 'text after a quoted string');
    return fold(body.slice(0, end).split('\n')).replace(/''/g, "'");
  }
  if (/^[&*!|>%@`]/.test(first)) fail(no, `unsupported YAML (${first[0]})`);
  if (first === '[]') { if (more.length) fail(no, 'text after []'); return []; }
  if (first === '{}') { if (more.length) fail(no, 'text after {}'); return {}; }
  if (first.startsWith('[') || first.startsWith('{')) fail(no, 'a flow collection with content');
  const text = fold([first.replace(/\s+#.*$/, ''), ...more.map((l) => l.text.replace(/\s+#.*$/, ''))]);
  if (more.length === 0) {
    if (text === 'true' || text === 'false') return text === 'true';
    if (text === 'null' || text === '~' || text === '') return null;
    if (/^-?(0|[1-9][0-9]*)$/.test(text)) return Number(text);
  }
  return text;
}

const KEY_RE = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/;

/** Parses the old saved YAML form into plain data; throws on anything else. */
export function parseSavedYaml(text: string): unknown {
  const lines: Line[] = [];
  text.replace(/\r\n/g, '\n').split('\n').forEach((raw, i) => {
    if (raw.trim() === '') { lines.push({ indent: -1, text: '', no: i + 1 }); return; }
    if (/^\s*#/.test(raw) || raw.trim() === '---' || raw.trim() === '...') return;
    if (/\t/.test(raw.match(/^\s*/)![0])) fail(i + 1, 'a tab in the indentation');
    lines.push({ indent: raw.length - raw.trimStart().length, text: raw.trim(), no: i + 1 });
  });
  let pos = 0;
  const skipBlank = () => { while (pos < lines.length && lines[pos]!.indent < 0) pos++; };

  /** Continuation lines of a scalar whose key sits at column `col`: deeper, or blank inside. */
  function continuation(col: number): Line[] {
    const out: Line[] = [];
    while (pos < lines.length) {
      const l = lines[pos]!;
      if (l.indent >= 0 && l.indent <= col) break;
      if (l.indent < 0) {
        let k = pos;
        while (k < lines.length && lines[k]!.indent < 0) k++;
        if (k >= lines.length || lines[k]!.indent <= col) break;
      }
      out.push(l.indent < 0 ? { ...l, text: '' } : l);
      pos++;
    }
    return out;
  }

  function value(rest: string | undefined, col: number, no: number): unknown {
    if (rest !== undefined && rest !== '' && !rest.startsWith('#')) return scalar(rest, continuation(col), no);
    skipBlank();
    const next = lines[pos];
    if (!next || next.indent < col || (next.indent === col && !next.text.startsWith('- '))) return null;
    return block(next.indent);
  }

  function mapping(col: number, firstEntry?: { key: string; rest: string | undefined; no: number }): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const add = (key: string, rest: string | undefined, no: number) => {
      if (Object.prototype.hasOwnProperty.call(out, key)) fail(no, `the key ${key} twice`);
      out[key] = value(rest, col, no);
    };
    if (firstEntry) add(firstEntry.key, firstEntry.rest, firstEntry.no);
    for (;;) {
      skipBlank();
      const l = lines[pos];
      if (!l || l.indent < col) return out;
      if (l.indent > col) fail(l.no, 'unexpected indentation');
      if (l.text.startsWith('- ')) return out;
      const m = KEY_RE.exec(l.text);
      if (!m) fail(l.no, 'not a "key: value" line');
      pos++;
      add(m![1]!, m![2], l.no);
    }
  }

  function sequence(col: number): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      skipBlank();
      const l = lines[pos];
      if (!l || l.indent !== col || !(l.text.startsWith('- ') || l.text === '-')) {
        if (l && l.indent > col) fail(l.no, 'unexpected indentation');
        return out;
      }
      pos++;
      const rest = l.text === '-' ? '' : l.text.slice(2).trim();
      const m = KEY_RE.exec(rest);
      if (m) out.push(mapping(col + 2, { key: m[1]!, rest: m[2], no: l.no }));
      else out.push(value(rest || undefined, col, l.no));
    }
  }

  function block(col: number): unknown {
    skipBlank();
    const l = lines[pos];
    if (!l) return null;
    return l.text.startsWith('- ') || l.text === '-' ? sequence(col) : mapping(col);
  }

  skipBlank();
  const doc = block(0);
  skipBlank();
  if (pos < lines.length) fail(lines[pos]!.no, 'text after the document');
  return doc;
}
