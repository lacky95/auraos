# core/src/runtimes (Execution): ARI

The sector rules are in `packages/core/AGENTS.md`. This module is the Aura Runtime Interface: the contract between the kernel and a runtime, the registry and the one resolver. Design: `ari-phase-draft.md` §2; plan `phase5b-plan.md` §3.

## Files

- **`ari.ts`**: the contract (`ARI_VERSION`, `RuntimeDescriptor`, `AuraRuntime`, `RuntimeModule`, `SpawnSpec`, `SessionSpec`, health, endpoint, `ariRefusal`). **`types.ts`**: capabilities (`RUNTIME_CAPABILITY_KEYS`), errors, the settings record. **`requirements.ts`**: `requirementsOf()` and `requestNeeds()`. **`workloadEnv.ts`**: the `AURA_*` a session must never see vs may see (`@aura/core/workload-env`; a golden test covers every variable the spawn args set). These four are contract leaves (`pnpm arch` rule `contract-leaf`): no runtime import of another core module.
- **`registry.ts`**: registration (refuses an ARI above `ARI_VERSION`, a bad id or descriptor, a duplicate), settings (migrated by `settingsVersion`; failure disables the runtime, never guessed values), health, `suggest`, `resolve`.
- **`settingsStore.ts`**: the sealed `user:policy:runtimes` record (owned here); the owner override (ARI-3: `checkOverride`, the one check for the dry run and the write; `setOverride`, compare-and-set on the override the owner saw); `runtimeSettingsRevision` (latched on an instance as `runtimeSettingsRev`). **`migrateLegacy.ts`**: D75, plus `resolutionOf` (one installation's resolution without starting) and `migrationReport` (read-only: no record, file or audit write).
- **`container/`** (5b CR): the container module over `ContainerRunner` (handed in; no runtime import of app-manager), its groups and `names.ts` (`containerName()`, the one Docker name rule). **`proot/`** (5b PR): placement-aware, pool refused clearly; groups `tools` only; actions `info`, `inspectRootfs`, `bench`, `version`, `baseInstall`, `upgrade` (routes authorize and audit; actions only execute, by argv, on the host executor they get). **`builtins/index.ts`**: `BUILTIN_RUNTIMES`. **`hostTools.ts`**: the `tools` group over the host allowlist dir (symlink mode reported `conditional`, `enforcement: advisory`). **`respawn.ts`** (5b RS): the kernel record of instances on non-surviving runtimes; `AppManager.init()` respawns them, the desktop only maps windows (`respawnedInstance`, `app:respawned`).

## Rules

- **Boundary shapes are plain data:** no `Map`, function or class instance in a spec, a result, an exit or usage; every refusal has a `code` (`runtimeRefusal()`). Callers check codes, not `instanceof`.
- **One needs derivation:** every capability need comes from `requirementsOf()` / `requestNeeds()`. Don't compute needs anywhere else.
- **Groups are neutral and honest (D100):** `adoption`, `sessions`, `workloads`, `tools`, `usage` (+ `actions`); present exactly when their feature is supported (`GROUP_FEATURE`, refused at `register`). Opaque refs, never a PID, container name, host path or engine handle at the contract. The kernel reaches them through the registry (`modulesWith`), never a concrete runner. `mounts`, `endpoints`, `build`, `logs` and the create/exec half of `workloads` are typed; their mechanism moves behind ARI in 5b-2 D (`GROUPS_PENDING_EXTRACTION`): add no new bypass.
- **Features are a derived view** (`featuresOf`, one table over the capabilities; `featureOverrides` only refines). Refusals carry a `category` (`CATEGORY_OF_CODE`); live operations return a `RuntimeOperationResult` with a terminal state.
- **Capabilities are honest and exhaustive.** A new flag goes into `RuntimeCapabilities`, `CAPABILITY_ORDER`, every module and the conformance kit in one change. A false capability fails closed, never downgrades.
- **Never auto-pick a runtime (Q17).** `suggest` only names candidates.
- **No installation changes runtime without a recorded decision (D75):** the migration record, an owner decision or override (audited), or a manifest that names its runtime. An override is capability-checked when set and at every start (no bypass).
- **G1:** a runtime reports exits through `onExit` only; it never imports `OsEventBus`. The kernel emits `app:*`.
- **D89:** `SpawnContext.instanceToken` is mandatory; every runtime injects `AURA_INSTANCE_TOKEN`.
- **A4:** host paths (`appDir`, `instanceDataDir`, tools dir, `home.hostPath`) only reach a runtime with `hostFilesystem`.
- **D64/D92:** every runtime switch is a security option (`runtimes`, `proot-host`, `runtime-install`).
- **R9:** the module activation record and the capability validator (`ariRefusal`, `missingCapabilities`) are written to be reused for system-service providers (BT-S); keep them provider-neutral.
- Golden argv (`test/golden-spawn-args.test.mjs`) stays byte-identical unless the owner approves a listed diff.

## Tests

`test/ari-conformance/kit.mjs` (`describeRuntime`, run by `ari-conformance.test.mjs` for every module, a fake and the reference mock provider `ari-conformance/mock.mjs`), `ari-modules.test.mjs` (CR/PR/RS), `ari-contract.test.mjs`, `runtimes.test.mjs`, `runtime-overrides.test.mjs` (M), `golden-spawn-args.test.mjs`.
