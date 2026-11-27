# core/src/approvals (Identity & Security)

Sector rules: `packages/core/AGENTS.md`. The approval state machine and its store; the shell's `lib/approvals/` is its transport and dialog.

## Contract

- **Entry point:** `index.ts` (`types.ts`, `state.ts`, `ValkeyApprovalStore.ts`, `keys.ts`). Leaves: `types.ts`, `keys.ts`.
- **Actions:** `APPROVAL_ACTIONS` in `types.ts`. A new action is a contract change (shell display, level, consume site).
- **Binding:** an approval binds `payloadHash(payload)` (`state.ts`). The payload is the exact thing approved: for installs `InstallBinding` (nexus), which for `app.patch.activate` includes the `PatchBinding` (base, series revision, digest, order, disabled, target; Phase 7a, Q23). Anything not in the payload is not approved.
- **Display:** `ApprovalDisplay` is server-built from verified data; `diff` carries a patch's exact change (Phase 7a). Requester words only as `reason`.

## State it owns (`keys.ts`, rule `kv-owner`)

- `approval:<id>` records, written only by `ValkeyApprovalStore` (Lua compare-and-set). Other modules name an approval with `approvalRef(id)`.
- **Events:** none.

## Invariants (and the test that proves each)

- Single use: a consumed approval never passes again (`approvals.test.mjs`, `approval-store.test.mjs`).
- A changed payload needs a new approval (`approvals.test.mjs`; for patches `phase7-patches.test.mjs` "binding", shell `app-source.test.ts` "Q23 binding").
- A missing client never auto-approves; pending approvals expire (`approvals.test.mjs`).
- Only a signed-in user on the shell or the host operator decides (D18, D45).

## Tests

`node tools/run-tests.mjs --only=core` (`approvals`, `approval-store`, `phase7-patches`) and `--only=shell` (`approvals*`, `app-source`).

## Decisions

D9 (levels), D18 (operator approval), D31 (installs are the owner's), D45, D49, D63, Q23 (approval integrity).
