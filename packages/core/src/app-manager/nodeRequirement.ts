/**
 * The Node requirement of this AuraOS (root `package.json` `engines.node`,
 * Phase 6 G) checked against an image's Node (the Astro 7 lesson: an
 * `aura-base` older than the floor breaks every container app at start).
 *
 * `satisfiesNode` is the release builder's base check (phase 6 B,
 * `os/release/images.mjs`) in TypeScript: the same npm-style ranges, the same
 * answers. The builder runs from the host without a built core, so it keeps
 * its dependency-free copy; `test/base-image.test.mjs` holds both to one
 * table when that file exists.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type V = [number, number | null, number | null];

const parseV = (v: string): V | null => {
  const m = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(String(v).trim());
  if (!m) return null;
  const n = (x: string | undefined) => (x === undefined || x === 'x' || x === '*' ? null : Number(x));
  return [Number(m[1]), n(m[2]), n(m[3])];
};
const cmp = (a: V, b: V) => { for (let i = 0; i < 3; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; };

function comparatorOk(version: V, comp: string): boolean {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comp)!;
  const op = m[1] ?? '';
  const want = parseV(m[2]!);
  if (!want) throw Object.assign(new Error(`unsupported engines.node comparator ${comp}`), { code: 'bad-engines' });
  const full = want.map((x) => x ?? 0) as V;
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
export function satisfiesNode(version: string, range: string | null | undefined): boolean {
  const v = parseV(version);
  if (!v || v.includes(null)) return false;
  if (!range || range.trim() === '' || range.trim() === '*') return true;
  return range.split('||').some((alt) => {
    const comps = alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    return comps.every((c) => comparatorOk(v, c));
  });
}

/** `engines.node` of the `package.json` next to `file` (the Dockerfile at the repo root); null when unreadable. */
export function requiredNodeNextTo(file: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(file), 'package.json'), 'utf-8')) as { engines?: { node?: unknown } };
    return typeof pkg.engines?.node === 'string' ? pkg.engines.node : null;
  } catch { return null; }
}

/**
 * Why `image` does not meet the requirement, naming the image and both
 * versions, or null. An unknown version or requirement is not a mismatch
 * (an image that is not a node image, a tree without `engines.node`).
 */
export function nodeMismatch(image: string, version: string | null, required: string | null): string | null {
  if (!version || !required) return null;
  return satisfiesNode(version, required) ? null : `${image} has Node ${version}, but this AuraOS requires ${required} (engines.node)`;
}
