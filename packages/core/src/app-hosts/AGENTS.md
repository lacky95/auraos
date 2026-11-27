# core/src/app-hosts (Communication)

Sector rules: `packages/core/AGENTS.md`. App Hosts (`{name}--{desktop host}`), installations and their identity, gateway contracts.

## Contract

- **Entry point:** `index.ts`. Leaves: `contracts.ts` (types), `keys.ts`, `relayClaim.ts` (a contract leaf). The host-name rules are Foundation: `types/hostRules.ts` (byte-identical copy in `packages/app-sdk/src/hostRules.ts`; edit both), subpath `@aura/core/host-rules`.
- **`services.ts`** creates the singleton: AppManager still fetches it (baselined, Phase 6 K).
- **Install lifecycle** (`lifecycle.ts`): `checkRestore`, `beginInstall`/`completeInstall`/`endInstall`, `approveExecution`, called by nexus inside its locked section.

## State it owns (`keys.ts`, rule `kv-owner`)

- `apphost:*` (records, installations `apphost:install:<installationId>`, manifest hosts), `hosts:`. Not a KvClient namespace, so `/api/kv` can't reach it.
- The `grant:` keys `AppHostRegistry.ts` mentions are `auth`'s (review misalignment 3: a comment, no access).
- **Events:** none.

## Invariants (and the test that proves each)

- A host name routes to one app; a protected name is never claimed (`app-hosts.test.mjs`, `host-rules.test.mjs`).
- Every mutation is one Lua compare-and-set over the keys it read (`app-host-registry.test.mjs`).
- Retained data goes only to the installation it belongs to (`app-host-registry.test.mjs`).

## Tests

`node tools/run-tests.mjs --only=core` (`app-hosts`, `app-host-registry`, `host-rules`, `relay-claim`, `aura-channel`, `phase5-app-identity`).

## Decisions

D19, D45, D47, D89 (relay claims), Q6.
