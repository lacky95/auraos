// Release images (Phase 6 stream B, step 4 and 5): which inputs an image
// target is built from, its fingerprint, and the `aura-base` Node check (the
// Astro 7 lesson: a release whose Node needs are newer than its images is
// refused before any switch). Dependency-free; reads files, runs nothing.
//
// The fingerprint of a target = sha256 over the Dockerfile, the target name,
// every build-context file the target's stages COPY/ADD (or bind-mount), and
// the extra inputs (the D94 render digest of the build's mirrors and bases).
// Only stages the target reaches count (FROM <stage>, COPY --from=<stage>),
// so a change under `packages/` does not rebuild an image that copies only `os/`.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join, normalize } from 'node:path';

/** Logical lines: continuations joined, comments and blanks dropped. */
function logicalLines(text) {
  const out = [];
  let cur = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!cur && /^\s*#/.test(line)) continue;
    if (/\\\s*$/.test(line)) { cur += `${line.replace(/\\\s*$/, '')} `; continue; }
    cur += line;
    if (cur.trim()) out.push(cur.trim());
    cur = '';
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const words = (s) => s.split(/\s+/).filter(Boolean);

/** Splits `COPY [--flag=x]… src… dest` (shell or JSON form) into flags and sources. */
function copyArgs(rest) {
  const parts = words(rest);
  const flags = {};
  while (parts[0]?.startsWith('--')) {
    const [k, v] = parts.shift().slice(2).split(/=(.*)/s);
    flags[k] = v ?? true;
  }
  let args = parts;
  const joined = parts.join(' ');
  if (joined.startsWith('[')) { try { args = JSON.parse(joined); } catch { /* shell form after all */ } }
  return { flags, srcs: args.slice(0, -1) };
}

/** Bind-mount sources of `RUN --mount=type=bind,source=x` (no `from`): they read the context too. */
function runBindSources(rest) {
  const srcs = [];
  for (const m of rest.matchAll(/--mount=(\S+)/g)) {
    const kv = Object.fromEntries(m[1].split(',').map((p) => p.split(/=(.*)/s)));
    if ((kv.type ?? 'bind') === 'bind' && !kv.from) srcs.push(kv.source ?? kv.src ?? '.');
  }
  return srcs;
}

/** Stages of a Dockerfile: [{ name, base, copies: [{ from, srcs }] }]. */
export function parseDockerfile(text) {
  const stages = [];
  let st = null;
  for (const line of logicalLines(text)) {
    const [instr, ...restWords] = words(line);
    const rest = line.slice(instr.length).trim();
    switch (instr.toUpperCase()) {
      case 'FROM': {
        const w = restWords.filter((x) => !x.startsWith('--'));
        const asIdx = w.findIndex((x) => x.toUpperCase() === 'AS');
        st = { name: asIdx >= 0 ? w[asIdx + 1] : String(stages.length), base: w[0], copies: [] };
        stages.push(st);
        break;
      }
      case 'COPY':
      case 'ADD': {
        if (!st) break;
        const { flags, srcs } = copyArgs(rest);
        st.copies.push({ from: typeof flags.from === 'string' ? flags.from : null, srcs: srcs.filter((s) => !/^[a-z]+:\/\//i.test(s)) });
        break;
      }
      case 'RUN': {
        if (!st) break;
        const srcs = runBindSources(rest);
        if (srcs.length) st.copies.push({ from: null, srcs });
        break;
      }
      default: break;
    }
  }
  return stages;
}

export const targetsOf = (text) => parseDockerfile(text).map((s) => s.name);

/** The stages `target` is built from (itself, its bases, its COPY --from stages), transitively. */
export function stageClosure(stages, target) {
  const byName = new Map(stages.map((s) => [s.name, s]));
  if (!byName.has(target)) throw Object.assign(new Error(`the Dockerfile has no stage ${target}`), { code: 'no-target' });
  const seen = new Set();
  const visit = (name) => {
    const s = byName.get(name);
    if (!s || seen.has(name)) return;
    seen.add(name);
    visit(s.base);
    for (const c of s.copies) if (c.from) visit(c.from);
  };
  visit(target);
  return stages.filter((s) => seen.has(s.name));
}

/** Context paths the target reads (sorted, normalized, no `..`). Wildcards widen to their directory. */
export function contextInputs(stages, target) {
  const out = new Set();
  for (const s of stageClosure(stages, target)) {
    for (const c of s.copies) {
      if (c.from) continue;
      for (let src of c.srcs) {
        if (/[*?[]/.test(src)) src = src.slice(0, src.search(/[*?[]/)).replace(/[^/]*$/, '') || '.';
        const n = normalize(src).replace(/^\/+/, '').replace(/\/+$/, '') || '.';
        if (n.split('/').includes('..')) throw Object.assign(new Error(`COPY source outside the context: ${src}`), { code: 'bad-dockerfile' });
        out.add(n);
      }
    }
  }
  return [...out].sort();
}

/** sha256 over the files under `rel` (path, mode bit, content), deterministic order. */
function hashTree(h, root, rel) {
  const p = rel === '.' ? root : join(root, rel);
  if (!existsSync(p)) { h.update(`missing\0${rel}\n`); return; }
  const st = lstatSync(p);
  if (st.isSymbolicLink()) { h.update(`link\0${rel}\0${readlinkSync(p)}\n`); return; }
  if (st.isFile()) {
    h.update(`file\0${rel}\0${st.mode & 0o100 ? 'x' : '-'}\0`).update(createHash('sha256').update(readFileSync(p)).digest('hex')).update('\n');
    return;
  }
  if (!st.isDirectory()) return;
  for (const name of readdirSync(p).sort()) {
    if (name === '.git' || name === 'node_modules') continue;
    hashTree(h, root, rel === '.' ? name : `${rel}/${name}`);
  }
}

/**
 * The image fingerprint of `target` in the tree at `root` (16 hex). `extra` is
 * any further input that must rebuild the image (the D94 render digest).
 */
export function imageFingerprint(root, target, { dockerfile = 'Dockerfile', extra = '' } = {}) {
  const text = readFileSync(join(root, dockerfile), 'utf8');
  const inputs = contextInputs(parseDockerfile(text), target);
  const h = createHash('sha256');
  h.update(`aura-image-v1\0${target}\0${extra}\0`).update(text).update('\0');
  for (const rel of inputs) hashTree(h, root, rel);
  return { fingerprint: h.digest('hex').slice(0, 16), inputs };
}

// ── engines.node check ──────────────────────────────────────────────────────

const parseV = (v) => {
  const m = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(String(v).trim());
  if (!m) return null;
  const n = (x) => (x === undefined || x === 'x' || x === '*' ? null : Number(x));
  return [Number(m[1]), n(m[2]), n(m[3])];
};
const cmp = (a, b) => { for (let i = 0; i < 3; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; };

function comparatorOk(version, comp) {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comp);
  const op = m[1] ?? '';
  const want = parseV(m[2]);
  if (!want) throw Object.assign(new Error(`unsupported engines.node comparator ${comp}`), { code: 'bad-engines' });
  const full = want.map((x) => x ?? 0);
  switch (op) {
    case '>=': return cmp(version, full) >= 0;
    case '>': return cmp(version, full) > 0;
    case '<=': return cmp(version, full) <= 0;
    case '<': return cmp(version, full) < 0;
    case '^': return cmp(version, full) >= 0 && version[0] === full[0] && (full[0] !== 0 || version[1] === full[1]);
    case '~': return cmp(version, full) >= 0 && version[0] === full[0] && (want[1] === null || version[1] === full[1]);
    default:  // exact or x-range
      return want.every((x, i) => x === null || version[i] === x);
  }
}

/** Does `version` (e.g. "v22.23.5") satisfy an npm-style range (`>=22.23.4`, `^22`, `>=20 <23 || 24.x`)? */
export function satisfiesNode(version, range) {
  const v = parseV(version);
  if (!v || v.includes(null)) return false;
  if (!range || range.trim() === '' || range.trim() === '*') return true;
  return range.split('||').some((alt) => {
    const comps = alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    return comps.every((c) => comparatorOk(v, c));
  });
}
