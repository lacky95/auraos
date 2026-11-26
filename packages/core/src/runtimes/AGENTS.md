# core/src/runtimes (Execution): ARI

The sector rules are in `packages/core/AGENTS.md`. This module is the Aura Runtime Interface: the contract between the kernel and a runtime, the registry and the one resolver. Design: `ari-phase-draft.md` §2; plan `phase5b-plan.md` §3.

## Files

- **`ari.ts`**: the contract (`ARI_VERSION`, `RuntimeDescriptor`, `AuraRuntime`, `RuntimeModule`, `SpawnSpec`, `SessionSpec`, health, endpoint, `ariRefusal`). **`types.ts`**: capabilities (`RUNTIME_CAPABILITY_KEYS`), errors, the settings record. **`requirements.ts`**: `requirementsOf()` and `requestNeeds()`. These three are contract leaves (`pnpm arch` rule `contract-leaf`): no runtime import of another core module.
- **`registry.ts`**: registration (refuses an ARI above `ARI_VERSION`, a bad id or descriptor, a duplicate), settings (migrated by `settingsVersion`; failure disables the runtime, never guessed values), health, `suggest`, `resolve`.
- **`settingsStore.ts`**: the sealed `user:policy:runtimes` record (owned here). **`migrateLegacy.ts`**: D75.
- **`builtins/`**: `BUILTIN_RUNTIMES` (container, proot) over today's runners. 5b CR/PR move them to `runtimes/<id>/`.

## Rules

- **Boundary shapes are plain data:** no `Map`, function or class instance in a spec, a result, an exit or usage; every refusal has a `code` (`runtimeRefusal()`). Callers check codes, not `instanceof`.
- **One needs derivation:** every capability need comes from `requirementsOf()` / `requestNeeds()`. Don't compute needs anywhere else.
- **Capabilities are honest and exhaustive.** A new flag goes into `RuntimeCapabilities`, `CAPABILITY_ORDER`, every module and the conformance kit in one change. A false capability fails closed, never downgrades.
- **Never auto-pick a runtime (Q17).** `suggest` only names candidates.
- **G1:** a runtime reports exits through `onExit` only; it never imports `OsEventBus`. The kernel emits `app:*`.
- **D89:** `SpawnContext.instanceToken` is mandatory; every runtime injects `AURA_INSTANCE_TOKEN`.
- **A4:** host paths (`appDir`, `instanceDataDir`, tools dir, `home.hostPath`) only reach a runtime with `hostFilesystem`.
- **D64/D92:** every runtime switch is a security option (`runtimes`, `proot-host`, `runtime-install`).
- **R9:** the module activation record and the capability validator (`ariRefusal`, `missingCapabilities`) are written to be reused for system-service providers (BT-S); keep them provider-neutral.
- Golden argv (`test/golden-spawn-args.test.mjs`) stays byte-identical unless the owner approves a listed diff.

## Tests

`test/ari-conformance/kit.mjs` (`describeRuntime`, run by `ari-conformance.test.mjs` for every module and a fake), `ari-contract.test.mjs`, `runtimes.test.mjs`, `golden-spawn-args.test.mjs`.
