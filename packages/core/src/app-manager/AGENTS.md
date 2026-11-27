# core/src/app-manager (Execution)

The sector rules are in `packages/core/AGENTS.md`. This module is the kernel's lifecycle engine and its busiest file set. Several streams work in it at once, so stay inside your assigned region.

## What lives here

- **`AppManager.ts`** (about 4,000 lines at 5-main, about 85 public methods): it is the kernel API the shell calls (`getAppManager()`, 105 shell files). It handles:
  - lifecycle (`init`, adoption, reconciler, start, stop, kill, pause, resume, `stopAll`);
  - services, warm pools, previews and intents;
  - enable state;
  - activities and navigation;
  - window flight (presentation, debt);
  - manifests, interfaces, sidecars and usage.
- **Runners:** `ContainerRunner.ts` and `ProotRunner.ts` implement `SandboxRunner.ts`. From 5b CR/PR they sit behind ARI modules in `core/src/runtimes/<id>/`.
- **Resource managers:** `SidecarManager`, `MountManager`, `PortManager` keep the policy and drive the runtime's groups (`workloads`, `mounts`, `endpoints`), never `ContainerRunner`. A writable cross-uid mount is an idmapped bind or refused (`idmappedMounts`, D80).
  - **5b-2 D:** `PortManager` keeps the policy and drives the runtime's `endpoints` group; `ExecBridge` holds no engine (sidecar exec/logs through `workloads`, instance logs through the module's `logs`); builds and provisioning go through the `build` group (`AppManager.builder()`); the orphan scan is the runtimes' `orphans`, liveness is `isRunning` only; the one `SpawnSpec` comes from `runtimes/spawnSpec.ts`. **Phase 6 D-S:** `SidecarManager` keeps the policy (who may act, the limit, tokens, tool grants, mounts, seed markers, readiness) and drives the runtime's `workloads` group (`runtimes/container/sidecars.ts`: the `docker create` argv, start and boot check, list, inspect, remove, seed, run, output; golden `test/golden-workload-args.test.mjs`); without one it refuses (`capability-missing: sidecars`). **Phase 6 D-M:** `MountManager` keeps kinds, nesting, the D80 plan, declarations, fan-out and reconcile, and drives the `mounts` group (`runtimes/container/mounts.ts`: helper bind/unbind, mount-table verify, root inspect). Spawn arg helpers: `runtimes/spawn/`.
  - **Engine helpers** (`engineSession`, `engineExec`, `engineLogs`) live in `DockerApi.ts` inside the boundary; an engine refusal is a neutral `RuntimeExecError` (`runtimes/types.ts`).
- **System Management parts that still live here:** `AppRegistry`, `appBuild`, `BaseImage`, `tool-provision`, `provisioning`. They move out in the Phase 8 decomposition.

## Rules

- **Don't add new responsibilities to `AppManager.ts`.**
  - New lifecycle behaviour goes in a focused file with its own contract, which AppManager calls.
  - New presentation behaviour doesn't belong in the kernel.
  - Phase 8 decomposes AppManager behind a facade. Code you add now should already have that shape.
- **Don't add a kind check** (`sandbox === 'container'` or `'proot'`) outside the runtime modules. Ask `AppManager.instanceCapabilities()` (effective: the runtime's, narrowed by the installation) instead (ARI, 5b G; `ari-coverage.test.mjs` fails on a new one).
- **Runners don't import `OsEventBus`.** They report exits through `onExit`; the kernel emits `app:*` (G1).
- **Keep the `SandboxRunner` and ARI arguments plain data.** The spawn context carries no functions and no live objects.
- **Collaborators are passed in.** Don't fetch them from `globalThis` or import a sibling module's `services.ts`. The auth services arrive as `opts.auth` from the composition point (5b K removed the `AppManager ↔ auth/services` cycle).
- **Every spawn mints a workload token** (D89). A container without one is never adopted.

## State

- **In memory:** instances, activities and flights.
- **Valkey:** `os:sidecars` (the limit).
- **Containers:** labels (`aura.token.nonce` and others).
- **Debt:** `os:app-enabled` is persisted by shell routes. AppManager takes it over in Phase 6 K.

## Tests

- **Suites:** `node tools/run-tests.mjs --only=core`. Relevant files:
  - `lifecycle-*`, `instance-tokens`, `sidecar-*`, `mount-manager`, `port-manager`, `container-*`;
  - `intent-dispatch` (12 known failures: it uses a fake `this`, because nothing can construct AppManager in a test yet).
- **Goldens:** spawn argv in `test/golden-spawn-args.test.mjs` (from 5-pre). It must stay byte-identical through refactors.
