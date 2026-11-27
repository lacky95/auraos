# core/src/auth (Identity & Security)

Sector rules: `packages/core/AGENTS.md`. Also covers `identity/` (Linux identities, root requests) and `permissions/` (manifest permissions) by pointer: their state is listed here; their code has no file of its own yet.

## Responsibility

Users, sessions and principals; grants; the authorizer; API keys; the admin audit trail. Transport-side enforcement is `packages/shell/src/lib/access`, never here.

## Contract

- **Entry point:** `index.ts`. Leaves others may import directly: `types.ts`, `keys.ts`, `identityKey.ts` (a contract leaf).
- **`services.ts`** is a composition root inside the module (constructs stores from AppManager, capabilities, security, identity): baselined, owner Phase 6 K (`bootSystem()`). Don't import it from another module; take the services as an argument (`opts.auth`, 5b K).
- **Audit:** `AdminAudit.record()` is the one writer of `audit:admin`. Action names are constants (`IDENTITY_AUDIT_ACTIONS`, `EXECUTION_AUDIT_ACTIONS`, `PATCH_AUDIT_ACTIONS` in `patches/types.ts`).

## State it owns (`keys.ts`, rule `kv-owner`)

- `usersess:`, `grant:`, `apikey:`, `audit:admin`, `user:policy:password`; `user:<id>:…` records (the `user:` space is shared: see the kernel file).
- **Events:** `auth:sessionsRevoked`, `permissions:changed` (rule `event-owner`).

## Invariants (and the test that proves each)

- Users are named by id, never username, in audit rows and grants (`auth.test.mjs`, `identity.test.mjs`).
- The audit drops secret-named fields at any depth (`auth.test.mjs`).
- Grants change only through `GrantStore` and are audited by the caller (`approvals.test.mjs`, `phase5-context.test.mjs`).
- No password, code, token or hash in any audit `detail`.

## Tests

`node tools/run-tests.mjs --only=core`: `auth`, `identity`, `login-session-live`, `phase5-identity`, `phase5-members`, `user-*`.

## Decisions

D50 (owner admin), D82/D83 (members, ids), D85 (systemId on records), D89 (workload identity from the token).
