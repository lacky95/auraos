# core/src/setup (System Management): app setup and operating profiles (D108)

The sector rules are in `packages/core/AGENTS.md`. Design: D108 (`app-profiles-setup-review.md` §2–§5, §9). The Phase 8 decomposition keeps this as the `setup` module (A4).

## Files

- **`contracts.ts`** (contract leaf): operational states and transitions, the desired-configuration record, the resolution (desired / authorized / effective), digests, resolver ports, D105 codes (`needs-setup`), the `app.setup.apply` payload and class, API/SDK views, hook contracts, audit and the `app:setup-state` event.
- **`index.ts`**: the module's public surface, re-exported by the core barrel. Named exports only; one region per work package.
- Related leaves outside this directory: `config/schema.ts` (the one field model, also behind runtime settings) and `types/setupManifest.ts` (the manifest blocks `setup`, `profiles`, `homeEnvironments`, env references).

## State it owns

- `app:config:<installationId>` and `app:config:<installationId>:u:<userId>`: the desired configuration (shared with D107-a), kernel-owned, MAC-sealed, CAS. No shell writes (D97).
- The `setup` summary on `apphost:install:<installationId>`, written only through `AppHostRegistry` (CAS).

## Invariants

- **Simple apps unchanged:** no `setup` and no `profiles` → no record, no state, `ready` by derivation; launch, spawn argv and `aura dev validate` identical.
- **Never a fallback:** an unmet required requirement, a missing grant, a policy `off` or an invalid field leaves NO effective configuration (D105 body); never Private→App Home, instance→shared network, unenforced limits or root.
- **Requests never grant:** profiles only add requests; authorization is the install approval, `app.setup.apply` (bound to `grantDigest` + `configDigest`) and existing grants.
- **Secrets only as vault handles:** never in a record, digest, log, error body or CLI output.
- `ready` is written only by the engine, by CAS with the validated `configDigest`.
