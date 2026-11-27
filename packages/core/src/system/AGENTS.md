# core/system: identity, readiness and the composition root (Foundation)

Principles: root `AGENTS.md`; sectors and direction: `packages/core/AGENTS.md`.

## Public contract
- `bootSystem(opts): SystemHandle` (`bootstrap.ts`): boots the kernel once per process; idempotent across module copies (the handle is pinned as `aura.system`). `getSystem()`, `restartKernel()` (soft restart), `shutdownSystem(reason)`.
- `types.ts` (leaf): `SystemHandle`, `BootStatus` (`status.json` v1), `BootHook` (`layer: server|webshell`, `phase: beforeApps|ready`), `Composition`.
- `systemIdentity.ts` (D47), `systemApps.ts` (leaf), `status.ts`, `kvBootstrap.ts` (the KV seed; its defaults are handed in).

## The composition root (D97)
- `compose.ts` constructs the service singletons (`AuthServices`, `AppHostServices`) and hands the notification service its collaborators; it runs when the barrel loads. `bootstrap.ts` is the order. Only these two files and the barrel may import other sectors, and only the barrel imports them (`pnpm arch`).
- Domain modules receive collaborators (AppManager `opts.auth`, `opts.appHosts`, `contractScan`); they never fetch them.

## Boot order (golden: `test/bootstrap.test.mjs`)
0. D94 IC-5: the infrastructure config applied to this process before any outbound call (`infra/kernel.ts` `loadInfrastructure()`: CA, proxy routing with internal traffic direct, env, live reload; `status.json.infra`); no config changes nothing; 1. identity first (A2), then `early` (mode-file migration); 2. Valkey, KV seed, the infrastructure seed (O2 policy, bootstrap credentials into the System Context), retired admin credential, notification sweeper; 3. `beforeApps` hooks; 4. Context files, volumes; 5. AppManager (enable state in its `init()`, custom interfaces, `init()`: adoption, boot reconciliation, respawn, services); 6. `kernelReadyAt`, then `ready` hooks (server layer first; Web Shell only in `desktop`).

## State it owns
- `/data/aura/boot/status.json` (atomic rename; `systemId`, `kernelReadyAt`, `firstRequestAt`, `services`, `hooks`, `infra`, `stoppedAt`).

## Invariants
- Init never depends on a request (D78); the server layer starts it (`server.mjs`, the dev plugin).
- A hook never fails the boot; a broken `system.json` never blocks it (reported in `identity`).
- One shutdown sequence (D77), under 8 s: hooks (Web Shell first, 3 s), respawn record frozen, reconciler, notifications, KV, Valkey. Container workloads keep running and are adopted.

## Tests
`node tools/run-tests.mjs --only=core` (`bootstrap.test.mjs`); the Headless acceptance test `hardening/phase6/headless-bootstrap` (auraos-e2e).
