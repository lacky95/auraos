# @aura/cli: the `aura` command

The CLI is a **client**: the host operator's and the user's way into AuraOS when there is no desktop (D73). The principles are in the root `AGENTS.md`.

## Rules (enforced: `package-internals`)

- **Its contract with the OS is the HTTP API.** Use `@aura/core` only for shared schemas and pure helpers (manifest schema, contract lint, patch-series helpers), never to drive kernel state directly.
  - **Debt:** `logs`, `exec` and `jump` still shell out to `docker` (`commands/verbs.ts`). Phase 5 stream X replaces that with API routes.
- **Owner actions go through approvals** (`aura approve`, operator tickets). The CLI never decides authorization itself.
- **`src/templates/app/`** is the app template that `aura dev new` copies, including its own `AGENTS.md` and `CLAUDE.md`. Those files are guidance for app authors, not for this repository.

## Tests

`node tools/run-tests.mjs --only=aura-cli` (`test/run.mjs`).
