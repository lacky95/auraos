# core/src/patches (System Management)

Sector rules: `packages/core/AGENTS.md`. The ONE patch series library (D68): the series file, per-patch validation, the series digest an approval binds, applying patches. Two engines use it: app patches (`aura dev patch`, the install pipeline) and system patches (`release/systemPatches.ts` and the release builder).

## Contract

- **Entry point:** `index.ts`. Leaf: `types.ts` (PatchTarget, PatchBinding, Series, ApplyResult, audit actions).
- **Portable modules:** `seriesFile.ts`, `digest.ts`, `validate.ts`, `apply.ts` import only `node:` builtins and `import type`. The release builder (`os/release/series-slot.mjs`) and `install.sh` run them **from source with Node's type stripping**, before anything is built. Keep them so: no value import of another module, no `.js` value specifier, no enum/namespace/parameter properties (`release-series.test.mjs` checks the imports).
- **The series file is written as JSON** (valid YAML): the builder reads it without a YAML parser; `series.ts` still reads YAML (v1 files and hand-written ones).

## State it owns

None: a patch repository belongs to its engine (app: the installation's patch repo; system: `/data/patches/system`, `release/systemPatches.ts`).

## Invariants (and the test that proves each)

- The digest covers target, base, each patch's bytes and enabled flag, in order; nothing else (`phase7-patches.test.mjs`).
- Refused content (escapes, git internals, submodules, the series itself, oversized, the system trust anchor) never reaches a tree: validated on save and before every apply (`phase7-patches.test.mjs`, `release-series.test.mjs`).
- The builder and the kernel compute the same digest (`release-series.test.mjs`).

## Tests

`node tools/run-tests.mjs --only=core` (`patch-series`, `phase7-patches`, `release-series`, `system-patches`).

## Decisions

D68, D71 (trust anchor), D73 (whole series, components), Q23.
