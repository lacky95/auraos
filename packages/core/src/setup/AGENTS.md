# core/src/setup (System Management): app setup and operating profiles (D108)

The sector rules are in `packages/core/AGENTS.md`. Design: D108 (`app-profiles-setup-review.md` §2–§5, §9). The Phase 8 decomposition keeps this as the `setup` module (A4).

## Files

- **`contracts.ts`** (contract leaf): operational states and transitions, the desired-configuration record, the resolution (desired / authorized / effective), digests, resolver ports, D105 codes (`needs-setup`), the `app.setup.apply` payload and class, API/SDK views, hook contracts, audit and the `app:setup-state` event.
- **`resolve.ts`** (P1): `resolveEffective(input, ports)`, the one pure resolver (desired → requested → effective, D105 `blocking`, never a fallback; `instanceScope: shared` refused until BT-M2); `autoSelectableProfile` (decision 3: exactly one feasible input-free profile, only for a caller that asks) and `profileOptions` (available + reasons).
- **`merge.ts`** (P1): the merge rules (overlay over base, desired overrides on the configurable keys, sorted request union, services by name with the overlay keys only, fields tightened never loosened) and `effectiveManifestView` (base order kept: an app without setup/profiles gets its base back).
- **`requirements.ts`** (P1): requirement evaluation through the `ResolverPorts`: explicit (`setup`/profile, level, `when`), implied (Private Home: D64 `app-private-home`, `home.private[.sidecar:<n>]`, `storage.privateHome`; `instance` network: `network.isolation`; resources: `resources.limits`) and derived (`requirementsOf()` → `FEATURE_OF_NEED`). Only `supported` meets a requirement.
- **`digest.ts`** (P1): `configDigestOf` (secrets by field name only) and `grantDigestOf` (`GrantBearing`), `sha256:<hex>` over canonical JSON.
- **`store.ts`** (P2): `SetupConfigStore`, the sealed `app:config:*` records (`read` → `{value, stored, tampered}`, `compareAndSet`, `update`, `forgetInstallation` revoking handles via `vaultHandleRevoker`). Wiring: `onTampered` → audit `tamperAuditInput`; lifecycle `forgetSetup`.
- **`state.ts`** (P2): `SetupStateMachine` over `AppHostStore.setSetup`: `state`, `begin`, `transition`, `progress`, `markReady` (the only way into `ready`), `desired` (tamper → `resetTampered`, once). Errors carry `code`.
- **`values.ts`** (P4): value delivery, by reference only. `setupConfigView` (the app's `/api/setup/self` view: values, secrets as handles); `sidecarSetupValues` (the `SpecEnvResolver` SidecarManager gets through `opts.setupValues`: `fromSetup` → literal, `map` must contain the value, arrays refused, inactive/unset fields leave the variable unset; `fromSecret` → a `{field, handle}` reference in the spec, the value read at create by `vaultSecretReader`); `secretReadableWithoutGrant` (a generated secret of the same installation needs no `credential.read` grant; shared with the shell's credentials.get); `generateSetupSecrets` over `CredentialVault.generate`.
- **`homeEnvironment.ts`** (P9, D107-a): the Private Home as home environment. `grantHomePrivate` (on the home user's `app.setup.apply`), `homePrivateAuthorized` (pure, P1 `isAuthorized`; facts from `loadHomePrivateFacts`), `privateHomeSpawnPort` (AppManager `privateHome`), `privateHomeTeardown` (revocation; never reconfigures).
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
