# core/src/setup (System Management): app setup and operating profiles (D108)

The sector rules are in `packages/core/AGENTS.md`. Design: D108 (`app-profiles-setup-review.md` §2–§5, §9). The Phase 8 decomposition keeps this as the `setup` module (A4).

## Files

- **`contracts.ts`** (contract leaf): operational states and transitions, the desired-configuration record, the resolution (desired / authorized / effective), digests, resolver ports, D105 codes (`needs-setup`), the `app.setup.apply` payload and class, API/SDK views, hook contracts, audit and the `app:setup-state` event.
- **`resolve.ts`** (P1): `resolveEffective(input, ports)`, the one pure resolver (never a fallback; `shared` refused until BT-M2); `autoSelectableProfile` (decision 3) and `profileOptions`.
- **`merge.ts`** (P1): the merge rules (overlay over base, desired overrides, sorted request union, services by name, fields tightened never loosened) and `effectiveManifestView` (a simple app gets its base back).
- **`requirements.ts`** (P1): requirement evaluation through the `ResolverPorts`: explicit (`setup`/profile, level, `when`), implied (Private Home, `instance` network, resources) and derived (`requirementsOf()` → `FEATURE_OF_NEED`). Only `supported` meets one.
- **`digest.ts`** (P1): `configDigestOf` (secrets by field name only) and `grantDigestOf` (`GrantBearing`), `sha256:<hex>` over canonical JSON.
- **`store.ts`** (P2): `SetupConfigStore`, the sealed `app:config:*` records (`read`, `compareAndSet`, `update`, `forgetInstallation` revoking handles via `vaultHandleRevoker`).
- **`state.ts`** (P2): `SetupStateMachine` over `AppHostStore.setSetup`: `state`, `begin`, `transition`, `progress`, `markReady` (the only way into `ready`), `desired` (tamper → `resetTampered`, once). Errors carry `code`.
- **`values.ts`** (P4): value delivery by reference only: `setupConfigView` (`/api/setup/self`, secrets as handles); `sidecarSetupValues` (SidecarManager `opts.setupValues`: `fromSetup` → literal, `map` must hold the value, arrays refused; `fromSecret` → `{field, handle}` in the spec, the value read at create by `vaultSecretReader`); `secretReadableWithoutGrant` (a generated secret of the same installation needs no `credential.read` grant); `generateSetupSecrets`.
- **`service.ts`** (P3): `SetupService`, the engine (`SetupServiceContract` + the `SetupGate` AppManager asks). Proposals are resolved before any write; `configuring` writes step + record first; added privileges → one `app.setup.apply` (requester = the actor) bound to both digests; on consumption grants via the existing paths; init in the maintenance start; `ready` only by `markReady`.
- **`ports.ts`** (P3, types only): `SetupEngineDeps`, the P9 `HomeEnvironmentPort`, `SetupGate`/`SetupEngine`. Wired by `system/compose.ts` `createSetupEngine` into AppManager `opts.setup`; the shell uses `getAppManager().setup`.
- **`approval.ts`**, **`hooks.ts`**, **`blocking.ts`** (P3): the approval payload and display (wording = @aura/ui `approvalSummary.ts`); `onSetup`/`onValidate` through the frozen `MaintenanceStarter` (none → fail closed); `blocked` on a lost grant, policy or feature, back to `ready` with the same digests.
- **`index.ts`**: the module's public surface, re-exported by the core barrel. Named exports only; one region per work package.
- Related leaves outside this directory: `config/schema.ts` (the one field model, also behind runtime settings) and `types/setupManifest.ts` (the manifest blocks `setup`, `profiles`, `homeEnvironments`, env references).

## State it owns

- `app:config:<installationId>` and `app:config:<installationId>:u:<userId>`: the desired configuration (shared with D107-a), kernel-owned, MAC-sealed, CAS. No shell writes (D97).
- The `setup` summary on `apphost:install:<installationId>`, written only through `AppHostRegistry` (CAS).

## Invariants

- **Simple apps unchanged:** no `setup` and no `profiles` → no record, no state, `ready` by derivation; launch, spawn argv and `aura dev validate` identical.
- **Never a fallback:** an unmet required requirement, a missing grant, a policy `off` or an invalid field leaves NO effective configuration (D105 body); never Private→App Home, instance→shared network, unenforced limits or root.
- **Requests never grant:** profiles only add requests; authorization is the install approval, `app.setup.apply` (bound to `grantDigest` + `configDigest`) and existing grants.
- **Secrets only as vault handles:** never in a record, digest, log, error body or CLI output. A sidecar spec and its hash carry a secret by reference (`secretEnv`), the value only reaches the container env.
- `ready` is written only by the engine, by CAS with the validated `configDigest`.
- **The gate** (`spawnContext`, `startIntent`, supervisor skip): `ready` and equal digests, else 409 `needs-setup`; only the engine's maintenance start passes while `initializing`; simple apps never reach it. Only the engine emits `app:setup-state`.
