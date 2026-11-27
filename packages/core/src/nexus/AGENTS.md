# core/src/nexus (System Management)

Sector rules: `packages/core/AGENTS.md`. Install, update and remove of apps; sources and registries; the store catalog; the app patch engine's install path (Track P, Phase 7a).

## Contract

- **Entry point:** `index.ts`. Leaves: `types.ts` (`InstallBinding`, `InstallRecord`, progress events), `keys.ts`.
- **One install pipeline:** `NexusManager.install()` for `nexus.install`, `nexus.update` and `app.patch.activate` (and its rollback). Steps: resolve, fetch, validate, identity, approval (the `InstallBinding`), then under the target's **activation lock** (`release/lock.ts`, `app:<scope>:<appId>`): **build before the swap** (`prepare`, the throwaway builder), the **atomic switch** (`Installer`), App Host records. No yield inside the locked section (callers may abandon the generator at any yield).
- **`Installer`:** journaled exchange (`aura-rename-exchange`, `renameat2 RENAME_EXCHANGE`), synced; `reconcile()` at boot (handed to AppManager as `installRecovery`); refuses installs on a filesystem without exchange support (`install-not-atomic`, no fallback).
- Errors carry a `code`: `activation-busy`, `install-prepare-failed` (+ `step`), `install-not-atomic`, `system-app-later`.

## State it owns

- Files: `<scope data>/nexus/{installed,journal,trash,retained,staging}`, `apps/<id>` of the global and user scopes.
- **Keys** (`keys.ts`, rule `kv-owner`): `os` namespace `nexus/` (sources, legacy registries, source seeds) through `osKv.ts`.
- **Events:** `nexus:*` (rule `event-owner`). Baselined: `osKv.ts` emits `kv:changed` (Phase 8).

## Invariants (and the test that proves each)

- `apps/<id>` is always the complete old or the complete new tree, data in place once (`phase7-patches.test.mjs` crash tests, `installer.test.mjs`).
- A build or provisioning failure moves nothing (`phase7-patches.test.mjs` "validate before the swap").
- One activation per installation at a time (`phase7-patches.test.mjs` "lock").
- Never replaces a different app (originId) or a dev checkout without `force` (`app-identity.test.mjs`).
- A built-in app is never patched by a same-id copy (`app-patch.test.mjs`).

## Tests

`node tools/run-tests.mjs --only=core` (`installer`, `app-patch`, `app-identity`, `app-host-registry`, `phase7-patches`, `nexus-*`).

## Decisions

D31, D36, D68 (app vs system patches), Q6, Q23, owner decisions Phase 7 1–2.
