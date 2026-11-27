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

### Label and trust invariants (D103 AA3)

- **A label is never derived from a value another party controls.** Labels are allocated by this registry from the local installation's manifest name through the proposer and the look-alike rule (`types/hostRules.ts`, `AppHostRegistry.ts`), never from a request header, a remote record or a peer system's label (`host-rules.test.mjs` look-alikes and the 63-character label, `app-host-registry.test.mjs` concurrency and tombstones).
- **appId-keyed trust applies only to an `active`, local record.** The D45 owner UI, `OWN_ORIGIN_ONLY_APPS` and `NO_SELF_FRAME_APPS` (shell `server/app-hosts.mjs`) are decided from `route.record.appId` only after the resolver returned an `active` record of this system; a retired, pending or remote record routes nowhere (`server/app-hosts.mjs`: `status !== 'active'` → missing).
- **Every consumer refuses an unknown `AppHostResolution` status.** A new status is fail-closed until each consumer handles it (the gateway, the WS proxy, the handoff); a rollback reads a remote label as `unknown` (`AppHostRegistry.ts`). Tests: `app-hosts-handoff.test.ts`, `app-gateway.test.ts`; a dedicated "unknown status refused by every consumer" table test is an open item (Phase 8).

## Tests

`node tools/run-tests.mjs --only=core` (`app-hosts`, `app-host-registry`, `host-rules`, `relay-claim`, `aura-channel`, `phase5-app-identity`).

## Decisions

D19, D45, D47, D89 (relay claims), Q6.
