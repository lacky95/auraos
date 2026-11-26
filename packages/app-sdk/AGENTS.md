# @aura/app-sdk: the public app contract

Apps (in any sandbox) build on this package. It is a **client** of the kernel's HTTP and OS API, not part of the kernel. The principles are in the root `AGENTS.md`.

## Rules (enforced: `sdk-core`, `package-internals`)

- **Take only types from `@aura/core`** (plus its declared leaf subpaths). The SDK never imports the kernel root at runtime, because apps must not load kernel code.
- **The exports in `package.json` are the app contract.** Changing or removing one is a breaking change: version it (`auraContract`, Phase 6 G), document it, and keep old apps working or refuse them clearly.
- **Talk to the OS only through its API.**
  - No Docker access.
  - The direct-Docker sidecar mode in `src/sidecars.ts` is removed in 5b (owner decision); use the `mode: 'os'` path.
- **Stay agent-agnostic (D96):** no product-specific config formats.

## Tests

`node tools/run-tests.mjs --only=app-sdk` (`test/*.test.mjs`, after `tsc`).
