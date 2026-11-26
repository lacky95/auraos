# shell/src/lib/access: access enforcement (Identity & Security, server side)

This is the transport-side enforcement point for every `/api` request, plus the WS and App Host surfaces through `server/access-bridge.mjs`. The policy decision is pure. It imports only core and this directory, and it stays that way.

## Contract

| Part | File | Rules |
|---|---|---|
| Route manifest | `routeManifest.ts` | **Deny by default:** a route without a rule is refused in `enforce` mode. Every new or changed route needs its row in the same commit. `pnpm security` (routes) and `access-enforce.test.ts` check this |
| Decision | `decide.ts` | Pure. Don't add I/O to it |
| Principal | `identify.ts` | One verified principal per request, including the D28 network caller and the workload token (D89). Never trust the client's address alone |
| Modes | `enforce.ts`, `server/access-mode.mjs` | `enforce` / `report` / `off` |
| Observer | `observer.ts` | Counts in `report` mode. Registered at the first request today (Phase 6 K: at boot). **Before it is registered, the surfaces fail closed** |

## Invariants

- **No bypass by header, Referer or body flag** (`autoApprove` is gone).
- **An owner action goes through approvals.** A missing client never auto-approves.
- **App Host gateway calls are decided once** (`gatewayCaller.ts`), never twice and never skipped.

## Tests

- `node tools/run-tests.mjs --only=shell`: `access-enforce`, `access-report`, `gateway-owner-ui`, `auth-*`;
- `pnpm security`;
- e2e: `diagnose/approvals-unbypassable` and `access-policy`.

**Changes here are security-critical.** They need L5 validation (D95) and a review.
