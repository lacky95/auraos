# @aura/core: the Application Kernel

Read the root `AGENTS.md` first: it holds the principles. This file covers the kernel's sectors, the direction of dependencies between them, kernel-wide invariants and the known debt. Module files (for example `src/app-manager/AGENTS.md`) hold the specifics.

## What the kernel is

The kernel decides and owns state. It covers:
- app lifecycle and runtimes;
- identity, authorization and approvals;
- homes, context and volumes;
- the Interface Registry and host routing;
- installation, patches and updates.

It never presents anything, and it never transports anything itself. HTTP lives in `packages/shell` (the server layer); the CLI and the Web Shell are clients.

**It must work with no Web Shell (D73, D78).** Services start in `AppManager.init()` with no session, and from Phase 6 `bootSystem()` boots the kernel eagerly.

## Sectors (D97, owner-adopted)

Sectors are logical groups over the existing directories. There is no sector directory, and nothing gets moved to make one. Each module (a top-level directory under `src/`) belongs to exactly one sector.

`tools/dep-check.mjs` reads the block below. Adding, removing or renaming a module without updating it fails `pnpm arch`.

```text dep-check:sectors
foundation: types logger ipc system index
execution: app-manager scopes runtimes
identity-security: auth permissions approvals security identity
resource: context users homes
communication: interfaces app-hosts content
system-management: nexus patches updater contract capabilities
platform-services: notifications
presentation-contracts: theme layout keymap
```

| Sector | Responsibility | Not here |
|---|---|---|
| **Foundation** (`types`, `logger`, `ipc`, `system`, `index`) | the manifest schema and shared types, logging, the event-bus primitive (`OsEventBus`), system identity (D47); from Phase 6 the composition root `system/bootstrap.ts` (`bootSystem()`); `index.ts` is the public barrel | any domain logic. **Foundation is leaf-only:** apart from the composition root and the barrel, it imports no other sector |
| **Execution** (`app-manager`, `scopes`, `runtimes`) | the app, instance and activity lifecycle; supervision, services and pools; intents; sidecars, ports and mounts as runtime capabilities; the ARI and the runtime providers (`ContainerRunner`, `ProotRunner`); the spawn context | window flight and other presentation (debt); install and build policy |
| **Identity & Security** (`auth`, `permissions`, `approvals`, `security`, `identity`) | users, sessions, principals; grants; the authorizer; the approval state machine; the D64 security options and policy records; the credential vault lives in `context/CredentialVault.ts` | transport-side enforcement, which is `packages/shell/src/lib/access` |
| **Resource** (`context`, `users`, `homes`) | Context env and secrets (sealed), volumes, per-user data, Private and App Homes | mounts and ports (Execution until 5b G) |
| **Communication** (`interfaces`, `app-hosts`, `content`) | the Interface Registry, App Host routing and gateway contracts, content providers; `IntentResolver` stays in `app-manager` for now | sockets, HTTP and WS, which are server-layer transport |
| **System Management** (`nexus`, `patches`, `updater`, `contract`, `capabilities`) | install and remove, sources and registries, app contract checks, patch series, the self-updater, the capability (tool) registry and provisioning; `AppRegistry.ts`, `appBuild.ts`, `BaseImage.ts` and `tool-*.ts` sit in `app-manager` (they move in the Phase 8 decomposition) | grants (Identity & Security) |
| **Platform services** (`notifications`) | a system service reached through its contract; not a kernel sector (D97 §4) | kernel decisions |
| **Presentation contracts** (`theme`, `layout`, `keymap`) | themes and icons, layout strategies and keymaps shared by the Web Shell, the SDK types and Settings; **outside the kernel boundary** (labelled now, relocated after the alpha) | anything the headless kernel needs |

## Dependency direction

- **Foundation** imports only Foundation. The exceptions are `system/bootstrap.ts` (the composition root) and `index.ts` (the barrel).
- **Kernel sectors** may import Foundation, and other sectors only through those sectors' contracts (leaf `types.ts` or `contracts.ts`, an `index.ts`). There must be no entanglement: if A imports B, then B's chain must not lead back into A.
- **Nothing in a kernel sector imports presentation contracts at runtime.** Type-only imports are allowed.
- **Platform services** may use kernel contracts; kernel sectors reach them only through a contract that is handed in.
- **Core never imports** `@aura/shell`, `@aura/ui`, `@aura/app-sdk`, `@aura/cli`, Astro, React or socket.io.

**Enforced by `pnpm arch`:** `core-cycle`, `core-module-cycle`, `core-forbidden`, `foundation-leaf`, `kernel-presentation` and `agent-agnostic`. Planned rules, each with a baseline: `contract-leaf` and `runtime-no-bus` (5b), `core-deep-import` and `event-owner` (Phase 7), `kv-owner` (Phase 7–8).

## Public contract

- **Today:** other packages import the root `@aura/core` (`src/index.ts`, 55 `export *`) or the declared leaf subpaths in `package.json` `exports`: `theme`, `keymap`, `setup-tickets`, `system-identity`, `logger`, `host-rules`, `aura-channel`.
- **Don't widen the barrel with implementation classes.** Phase 8 narrows it.
- **Inside core**, cross-module imports go straight to implementation files today (131 imports, none through an `index.ts`). New code imports another module's leaf contract file or its `index.ts`. Phase 7 adds the `core-deep-import` rule with a baseline.

## State ownership (kernel-wide)

| State | Owner | Notes |
|---|---|---|
| `user:<id>:…`, `usersess:`, `grant:`, `audit:admin` | `auth` | `security` (`user:…:policy`) and `capabilities` (`user:…:capabilities`) own their sub-keys |
| `approval:` | `approvals` | Lua compare-and-set; single use |
| `context:*` | `context` | never readable through `/api/kv` |
| `apphost:*`, `hosts:` | `app-hosts` | |
| `notif:*` | `notifications` | |
| `os:sidecars` | `app-manager` (`SidecarManager`) | editable through `/api/kv/os/sidecars` |
| `os:app-enabled` | **unowned (debt):** written by shell routes, hydrated by the middleware | Phase 6 K: AppManager owns it |
| Events (`OsEvents` in `ipc/OsEventBus.ts`) | the emitting module | `app:*` events come only from the kernel (G1, 5b). Debt: `activity:*` is also emitted by API routes and `app:restart*` by `shell/lib/appRestart.ts`. Phase 7 adds `event-owner` |

**Singletons pinned on `globalThis`** (two copies of core exist: the Astro SSR bundle and the Node `dist`):
- `AppManager`, `AuthServices`, `OsEventBus`, `BaseImage`, Nexus, `AppHostServices`;
- `LayoutStrategyRegistry`, `KeymapRegistry`, registry logins, the system identity cache;
- `NotificationService` (plus its hooks and cache).

Add no new one. From Phase 6, `bootSystem()` creates them in one place.

## Kernel-wide invariants

- **Fail closed.** A runtime, home or identity that can't be provided securely refuses with a clear error; it never silently downgrades (ARI-4, D74, D89).
- **A missing approval client never auto-approves.** A pending approval expires.
- **Workload identity comes from the token,** never from the network address (D89). The kernel mints the token on every spawn.
- **The kernel reports runtime exits** (`app:crashed`, `app:stateChanged`); a runtime never emits on the bus (G1).
- **No local assumption is added** where D85 keeps multi-system open: `systemId` stays on records, refs are qualified.
- **Agent-agnostic:** kernel contracts and code never name an agent product (`claude`, `codex`, `.claude`, `CODEX_HOME`, `config.toml`, ...). An app or adapter supplies product specifics as data or through a generic contract; the kernel keeps authorization and enforcement.

## Known debt (`tools/dep-baseline.json`; each entry has an owner, and it must shrink)

| Violation | Owner |
|---|---|
| `auth/services.ts` composes AppManager, capabilities and security (`auth → app-manager, capabilities, security`) | Phase 6 K: composition moves into `bootSystem()` |
| `AppManager → app-hosts/services` (fetches the singleton itself) | Phase 6 K |
| `NotificationService → auth/services`, plus a hidden `globalThis` read of AppManager (`NotificationService.ts:1729`) | Phase 6 K: inject the lookups |
| `app-hosts/lifecycle.ts → app-manager/AppIdentity` | Phase 7 (contract leaf) |
| `nexus/removeApp.ts → AppManager` | Phase 7 (removal contract) |
| `types/manifest.ts → app-hosts/appHosts` (Foundation not a leaf) | Phase 7 (host-name rules into Foundation) |
| `AppManager → keymap/KeymapRegistry` (kernel uses presentation) | Phase 8 (AppManager decomposition) |
| Arriving with 5-main: `AppManager ↔ auth/services` (stream A's dynamic import) | 5b K |
| Arriving with 5-main: `runtimes/builtins → app-manager/ProotRunner` (R2) | 5b CR, PR |
| `agent-agnostic` hits: home seeder, home import markers, privilege notes (audit #2, #10/#11); the `claude-code` alias (#5) | 5b; Phase 6 |

**Phase 8 (committed):** AppManager is decomposed behind a compatibility facade into real modules. Each gets its own responsibility, state, contract and tests: activities and navigation, the service supervisor, previews, build and tools.

## Tests

| What | Where |
|---|---|
| Core suites | `node tools/run-tests.mjs --only=core`, or `pnpm --filter @aura/core test`. A test file must be listed in `package.json` `scripts.test` to run |
| Contract and golden tests | `test/*golden*`; ARI conformance (`test/ari-conformance/**`) from 5b. Reuse that pattern for module contract tests |
| Known failures | the auraos-e2e repo, `docs/known-failures.md` |

## Extending or replacing a module

- **A new module:**
  - put it in a sector, in the block above;
  - give it a leaf contract file;
  - declare the keys and events it owns;
  - add contract tests;
  - add an `AGENTS.md` when other agents will work in it.
- **A replacement implementation** (TS or another language) keeps the module's contract, its error codes, the state it owns and its security tests, and passes the same contract and conformance suite.
- **At provider boundaries** (ARI first), pass plain data only.
