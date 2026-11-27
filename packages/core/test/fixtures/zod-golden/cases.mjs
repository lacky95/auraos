import { createHash } from 'node:crypto';

// Shared by generate.mjs (records the golden) and test/zod-golden.test.mjs (replays it).

/** The values a generated case puts at a path ('delete' removes the key). */
export const MUTATION_VALUES = {
  delete: undefined,
  undefined: undefined,
  null: null,
  zero: 0,
  negative: -1,
  float: 1.5,
  big: 1e9,
  string: 'x',
  empty: '',
  long: 'A'.repeat(300),
  bool: true,
  array: [],
  numArray: [1],
  object: {},
  unknownKey: { zz: 1 },
};

/** Every path into objects and arrays (arrays: the first element only). */
export function objectPaths(value, prefix = []) {
  const out = [];
  if (Array.isArray(value)) {
    if (value.length) { out.push([...prefix, 0]); out.push(...objectPaths(value[0], [...prefix, 0])); }
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      out.push([...prefix, k]);
      out.push(...objectPaths(value[k], [...prefix, k]));
    }
  }
  return out;
}

const revive = (v) => (v && typeof v === 'object' && !Array.isArray(v) && v.$undefined === true && Object.keys(v).length === 1 ? undefined : v);

/** A deep copy of `seed` with one mutation applied ({path, value: label} or {path, literal}). */
export function applyMutation(seed, mutation) {
  if (!mutation) return structuredClone(seed);
  const v = 'literal' in mutation ? revive(structuredClone(mutation.literal)) : structuredClone(MUTATION_VALUES[mutation.value]);
  if (!mutation.path.length) return v;
  const root = structuredClone(seed);
  let at = root;
  for (const p of mutation.path.slice(0, -1)) at = at[p];
  const last = mutation.path.at(-1);
  if (mutation.value === 'delete') {
    if (Array.isArray(at)) at.splice(last, 1); else delete at[last];
  } else {
    at[last] = v;
  }
  return root;
}

/** Stable JSON-able form: sorted keys, `undefined` kept as a marker. */
export function canonical(v) {
  if (v === undefined) return { $undefined: true };
  if (typeof v === 'number' && !Number.isFinite(v)) return { $number: String(v) };
  if (typeof v === 'bigint') return { $bigint: String(v) };
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonical(v[k]);
    return o;
  }
  return v;
}

/** Short hash of the canonical form, for the golden's mutated cases. */
export function dataHash(v) {
  return createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex').slice(0, 16);
}
