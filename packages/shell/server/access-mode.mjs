/**
 * AURA_ACCESS_ENFORCE: the one place the access mode is read (D36). Plain
 * `.mjs` with no imports, so the Astro middleware, lib/access and the shell's
 * `.mjs` servers all ask the same function.
 *
 *   off       no access report and no manifest enforcement: the observer,
 *             surface events and the internal service label are all off.
 *   report    (default) every decision is counted in the access report;
 *             nothing is refused because of it. A would-deny row is marked
 *             `wouldEnforce`.
 *   enforce   the central middleware refuses what the manifest denies
 *             (Phase 3 stream A), and the report keeps counting.
 *
 * App Host gateway calls (`/_aura/os/*`) are enforced in every mode: that is
 * the Phase 2 boundary, not this switch. An unknown value counts as the
 * default and is logged once, so a typo never silently turns reporting off.
 * Read on every call: the value is fixed per process, tests change it.
 */

export const ACCESS_MODES = Object.freeze(['off', 'report', 'enforce']);
export const DEFAULT_ACCESS_MODE = 'report';
export const ACCESS_MODE_ENV = 'AURA_ACCESS_ENFORCE';

/** The mode a raw value names: unset or empty is the default, anything else unknown is null. */
export function parseAccessMode(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === '') return DEFAULT_ACCESS_MODE;
  return ACCESS_MODES.includes(v) ? v : null;
}

let warned = false;

/** The access mode of this process. */
export function accessMode() {
  const mode = parseAccessMode(process.env[ACCESS_MODE_ENV]);
  if (mode) return mode;
  if (!warned) {
    warned = true;
    console.warn(`[access] ${ACCESS_MODE_ENV} is not one of ${ACCESS_MODES.join('|')}; using ${DEFAULT_ACCESS_MODE}`);
  }
  return DEFAULT_ACCESS_MODE;
}

/**
 * Whether a report row marks a decision `enforce` would act on: in `report`,
 * any outcome but `allow`, unless the request was already refused by an
 * enforcement that runs in every mode (an App Host gateway call).
 */
export function wouldEnforce(mode, decision, enforcedAlready = false) {
  return mode === 'report' && decision !== 'allow' && !enforcedAlready;
}
