// The D68 series slot of a release (Phase 6 stream B, step 3). Phase 6 applies
// no system patches: the slot is always the EMPTY series, and its digest goes
// into release.json and into the `system.release.activate` approval binding,
// so the binding's shape does not change when Phase 7 fills it.
//
// Phase 7 (stream S, system patch engine) reads `patches/system/aura-patches.yaml`
// with core's series library, applies it to the staging tree (`applySeries`)
// right after the staged-tree check, and passes the same { base, order } here:
// `seriesDigest` is the one digest function for both sides.
//
//   seriesDigest({ base, order })   sha256 over canonical JSON
//     base:  null | { commit, version? }       the signed release the series applies to
//     order: [{ file, sha256 }]                patch files in apply order, by content
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

export const EMPTY_SERIES = Object.freeze({ base: null, order: Object.freeze([]) });

export function seriesDigest({ base = null, order = [] } = {}) {
  const canon = JSON.stringify({
    v: 1,
    base: base ? { commit: base.commit, version: base.version ?? null } : null,
    order: order.map((p) => ({ file: p.file, sha256: p.sha256 })),
  });
  return `sha256:${createHash('sha256').update(canon).digest('hex')}`;
}

export const EMPTY_SERIES_DIGEST = seriesDigest(EMPTY_SERIES);

/**
 * The series of a Phase 6 build: `requested` (Phase 7's build(commit, series)
 * input) or the series file on the data volume. A non-empty series is refused
 * in Phase 6: nothing would apply it, and the release would then claim content
 * it does not have.
 */
export function seriesForBuild({ seriesFile, requested = null } = {}) {
  if (requested && requested.order?.length) {
    throw Object.assign(new Error(`a system patch series (${requested.order.length} patches) cannot be built yet: system patches arrive with Phase 7 (D68)`), { code: 'series-unsupported' });
  }
  if (seriesFile && existsSync(seriesFile)) {
    throw Object.assign(new Error(`${seriesFile} exists: system patches arrive with Phase 7 (D68); remove it or wait for Phase 7`), { code: 'series-unsupported' });
  }
  return { ...EMPTY_SERIES, order: [], digest: EMPTY_SERIES_DIGEST };
}
