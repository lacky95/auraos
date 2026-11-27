# core/src/runtimes (Execution): ARI

The sector rules are in `packages/core/AGENTS.md`. This module is the Aura Runtime Interface: the contract between the kernel and a runtime, the registry and the one resolver. Design: `ari-phase-draft.md` §2; plan `phase5b-plan.md` §3.

## Files

- **`ari.ts`**: the contract (`ARI_VERSION`, `RuntimeDescriptor`, `AuraRuntime`, `RuntimeModule`, `SpawnSpec`, `SessionSpec`, health, endpoint, `ariRefusal`). **`types.ts`**: capabilities (`RUNTIME_CAPABILITY_KEYS`), errors, the settings record. **`requirements.ts`**: `requirementsOf()`, `requestNeeds()`, `instanceCapabilities()` (per instance). **`workloadEnv.ts`**: the `AURA_*` a session must never see vs may see (`@aura/core/workload-env`; golden-tested). These four are contract leaves (`pnpm arch` rule `contract-leaf`): no runtime import of another core module.
- **`registry.ts`**: registration (refuses an ARI above `ARI_VERSION`, a bad id or descriptor, a duplicate), settings (migrated by `settingsVersion`; failure disables the runtime, never guessed values), health, `suggest`, `resolve`.
- **`settingsStore.ts`**: the sealed `user:policy:runtimes` record (owned here); ARI-3 overrides (`checkOverride`: the one check, dry run and write; `setOverride`: CAS); `runtimeSettingsRevision`. **`migrateLegacy.ts`**: D75, `resolutionOf`, `migrationReport` (read-only).
- **`container/`** (5b CR): the container module over `ContainerRunner` (handed in; no runtime import of app-manager), its groups, `names.ts` (the one Docker name rule), `backends.ts` (the runner's facts), `networks.ts`, `diagnostics.ts`, `endpoints.ts`, `sidecars.ts` (OS sidecars in `workloads`, D-S), `mounts.ts` (`mounts`, D-M). **`spawn/`**: the runners' and modules' spawn arg helpers; `paths.ts`: in-workload paths. **`spawnSpec.ts`**: `buildSpawnSpec()` (one spec per start; A4). **`proot/`** (5b PR): placement-aware, pool refused clearly; groups `tools` only; actions `info`, `inspectRootfs`, `bench`, `version`, `baseInstall`, `upgrade` (routes authorize and audit; actions execute by argv). **`builtins/index.ts`**: `BUILTIN_RUNTIMES`. **`hostTools.ts`**: the `tools` group over the host allowlist dir (symlink mode reported `conditional`, `enforcement: advisory`). **`respawn.ts`** (5b RS): the kernel record of instances on non-surviving runtimes; `AppManager.init()` respawns them (`app:respawned`).

## Rules

- **Boundary shapes are plain data:** no `Map`, function or class instance in a spec, a result, an exit or usage; every refusal has a `code` (`runtimeRefusal()`). Callers check codes, not `instanceof`.
- **One needs derivation:** every capability need comes from `requirementsOf()` / `requestNeeds()`. Don't compute needs anywhere else.
- **Groups are neutral and honest (D100):** `adoption`, `sessions`, `workloads`, `tools`, `usage`, `endpoints`, `build`, `mounts`; present exactly when their feature is supported (`GROUP_FEATURE`, refused at `register`); feature-less: `logs`, `diagnostics`, `orphans`, `actions`. Opaque refs at the contract (no PID, container name or engine handle); the kernel reaches groups through the registry, never a runner. Managers keep policy only; `ari-coverage.test.mjs` allows no new bypass.
- **Features are a derived view** (`featuresOf`, one table over the capabilities; `featureOverrides` only refines). Refusals carry a `category` (`CATEGORY_OF_CODE`); live operations return a `RuntimeOperationResult` with a terminal state.
- **Capabilities are honest and exhaustive.** A new flag goes into `RuntimeCapabilities`, `CAPABILITY_ORDER`, every module and the conformance kit in one change. A false capability fails closed, never downgrades.
- **Never auto-pick a runtime (Q17).** `suggest` only names candidates.
- **No installation changes runtime without a recorded decision (D75).** An override is capability-checked when set and at every start.
- **G1:** a runtime reports exits through `onExit` only; it never imports `OsEventBus`. The kernel emits `app:*`.
- **D89:** `SpawnContext.instanceToken` is mandatory; every runtime injects `AURA_INSTANCE_TOKEN`.
- **A4:** host paths (`appDir`, `instanceDataDir`, tools dir, `home.hostPath`) only reach a runtime with `hostFilesystem`.
- **D64/D92:** every runtime switch is a security option (`runtimes`, `proot-host`, `runtime-install`).
- **R9:** the module activation record and the capability validator (`ariRefusal`, `missingCapabilities`) serve system-service providers too (BT-S): keep them neutral.
- Golden argv (`test/golden-spawn-args.test.mjs`, `golden-workload-args.test.mjs`) stays byte-identical unless the owner approves a listed diff.

## Tests

`test/ari-conformance/kit.mjs` (`describeRuntime`, run by `ari-conformance.test.mjs` for every module, a fake and the reference mock provider `ari-conformance/mock.mjs`), `ari-coverage.test.mjs`, `ari-negative.test.mjs`, `ari-modules.test.mjs`, `ari-contract.test.mjs`, `runtimes.test.mjs`, `runtime-overrides.test.mjs`, `golden-spawn-args.test.mjs`.
