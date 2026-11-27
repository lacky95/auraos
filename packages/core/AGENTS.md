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
system-management: nexus patches release updater contract capabilities
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
| **System Management** (`nexus`, `patches`, `release`, `updater`, `contract`, `capabilities`) | install and remove, sources and registries, app contract checks, patch series, the activation lock and crash points (`release`, Phase 7a; the release builder joins in Phase 6), the self-updater, the capability (tool) registry, the `tools[]` allowlist rules (`capabilities/tool-allowlist.ts`, a leaf: no imports) and provisioning; `AppRegistry.ts`, `appBuild.ts`, `BaseImage.ts` and `tool-provision.ts` sit in `app-manager` (they move in the Phase 8 decomposition) | grants (Identity & Security) |
| **Platform services** (`notifications`) | a system service reached through its contract; not a kernel sector (D97 §4) | kernel decisions |
| **Presentation contracts** (`theme`, `layout`, `keymap`) | themes and icons, layout strategies and keymaps shared by the Web Shell, the SDK types and Settings; **outside the kernel boundary** (labelled now, relocated after the alpha) | anything the headless kernel needs |

## Dependency direction

- **Foundation** imports only Foundation. The exceptions are `system/bootstrap.ts` (the composition root) and `index.ts` (the barrel).
- **Kernel sectors** may import Foundation, and other sectors only through those sectors' contracts (leaf `types.ts` or `contracts.ts`, an `index.ts`). There must be no entanglement: if A imports B, then B's chain must not lead back into A.
- **Nothing in a kernel sector imports presentation contracts at runtime.** Type-only imports are allowed.
- **Platform services** may use kernel contracts; kernel sectors reach them only through a contract that is handed in.
- **Core never imports** `@aura/shell`, `@aura/ui`, `@aura/app-sdk`, `@aura/cli`, Astro, React or socket.io.

**Enforced by `pnpm arch`:** `core-cycle`, `core-module-cycle`, `core-forbidden`, `foundation-leaf`, `kernel-presentation`, `contract-leaf` (5b), `agent-agnostic`, and from Phase 7 `core-deep-import`, `event-owner` and `kv-owner` (keys of auth, approvals, app-hosts, nexus). Planned: `runtime-no-bus` (5b-2).

## Public contract

- **Today:** other packages import the root `@aura/core` (`src/index.ts`, 78 `export *` lines) or the declared leaf subpaths in `package.json` `exports`: `theme`, `keymap`, `setup-tickets`, `system-identity`, `system-apps`, `workload-env`, `logger`, `host-rules`, `aura-channel`.
- **Don't widen the barrel with implementation classes.** Phase 8 narrows it.
- **Inside core**, a cross-module import targets the other module's `index.ts`, a leaf (`types.ts`, `contracts.ts`, `keys.ts`, `ari.ts`) or a declared contract leaf (`CONTRACT_LEAVES` in `tools/dep-check.mjs`); Foundation is imported directly. Rule `core-deep-import`; the remaining deep imports are baselined (Phase 8).
- **Module files** (contract, keys, events, invariants): `src/auth/`, `src/approvals/`, `src/nexus/`, `src/app-hosts/`, `src/app-manager/`, `src/runtimes/` each have an `AGENTS.md`.

## State ownership (kernel-wide)

| State | Owner | Notes |
|---|---|---|
| `user:<id>:…`, `user:policy:password`, `usersess:`, `grant:`, `audit:admin` | `auth` | the `user:` prefix has four owners: also `security` (`user:policy:security`), `runtimes` (`user:policy:runtimes`), `capabilities` (`user:capabilities:registry`) |
| `approval:` | `approvals` | Lua compare-and-set; single use |
| `context:*` | `context` | never readable through `/api/kv` |
| `apphost:*`, `hosts:` | `app-hosts` | |
| `notif:*` | `notifications` | |
| `os:sidecars` | `app-manager` (`SidecarManager`) | editable through `/api/kv/os/sidecars` |
| `os:app-enabled` | **unowned (debt):** written by shell routes, hydrated by the middleware | Phase 6 K: AppManager owns it |
| Events (`OsEvents` in `ipc/OsEventBus.ts`) | the owner in its `dep-check:event-owners` block | rule `event-owner`: emitted only in the owner's files. `app:*` and `activity:*` are app-manager's (the activity routes call the kernel since Phase 7); the remaining shell emits are baselined |
| Key prefixes in a module's `keys.ts` (`*_KV_PREFIXES`) | that module | rule `kv-owner`: auth, approvals, app-hosts, nexus (Phase 7); the rest in Phase 8 |

**Singletons pinned on `globalThis`** (two copies of core exist: the Astro SSR bundle and the Node `dist`):
- `AppManager`, `AuthServices`, `OsEventBus`, `BaseImage`, Nexus, `AppHostServices`;
- `LayoutStrategyRegistry`, `KeymapRegistry`, registry logins, the system identity cache;
- `NotificationService` (plus its hooks and cache).

Each module creates its own lazily today. Add no new one; Phase 6 K moves their creation into `bootSystem()`.

## Kernel-wide invariants

- **Fail closed.** A runtime, home or identity that can't be provided securely refuses with a clear error; it never silently downgrades (ARI-4, D74, D89).
- **A missing approval client never auto-approves.** A pending approval expires.
- **Workload identity comes from the token,** never from the network address (D89). The kernel mints the token on every spawn.
- **The kernel reports runtime exits** (`app:crashed`, `app:stateChanged`); a runtime never emits on the bus (G1).
- **No local assumption is added** where D85 keeps multi-system open: `systemId` stays on records, refs are qualified.
- **Agent-agnostic:** kernel contracts and code never name an agent product (`claude`, `codex`, `.claude`, `CODEX_HOME`, `config.toml`, ...). An app or adapter supplies product specifics as data or through a generic contract; the kernel keeps authorization and enforcement.

## Known debt

`tools/dep-baseline.json` is the one list: each entry names its owning phase, and it must shrink (`pnpm arch` reports a fixed entry). Phase 7 removed the `app-hosts`/`nexus` → `app-manager` cycles and the Foundation exception, and recorded the debt of its three new rules.

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
