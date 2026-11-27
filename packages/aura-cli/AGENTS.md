# @aura/cli: the `aura` command

The CLI is a **client**: the host operator's and the user's way into AuraOS when there is no desktop (D73). The principles are in the root `AGENTS.md`.

## Rules (enforced: `package-internals`)

- **Its contract with the OS is the HTTP API.** Use `@aura/core` only for shared schemas and pure helpers (manifest schema, contract lint, patch-series helpers), never to drive kernel state directly.
  - **Debt:** `logs`, `exec` and `jump` still shell out to `docker` (`commands/verbs.ts`). Phase 5 stream X replaces that with API routes.
- **Owner actions go through approvals** (`aura approve`, operator tickets). The CLI never decides authorization itself.
- **`src/templates/app/`** is the app template that `aura dev new` copies, including its own `AGENTS.md` and `CLAUDE.md`. Those files are guidance for app authors, not for this repository.

## Tests

`node tools/run-tests.mjs --only=aura-cli` (`test/run.mjs`).

## The human CLI is a compatibility contract (D109 Addendum)

- **`--agent` is reserved** for the agent interface (D109). No command defines an option of that name; `src/lib/invocation.ts` takes it before commander (never after a bare `--`, never as an option's value) and, until the agent interface exists, answers it with a usage error (exit 2) without running anything.
- **`--help` never runs an action.** `test/invocation.test.ts` checks every command.
- **The human help and the TUI frames are golden** (`test/golden/`): the baseline of the Addendum's byte-identity rule. A change to them is a change of the human CLI, which needs the owner's approval; regenerate with `AURA_UPDATE_GOLDEN=1` only then.

## Responsibility boundary (D111, D96)

- The core `aura` CLI covers **native AuraOS concepts, resources and operations only**: never a third-party app's configuration or internals.
- **No app-specific configuration** (Claude Code, Codex, other agents): it belongs to the app or its integration adapter (D96, e.g. the optional `~/.aura/adapters/mcp-clients.mjs`). Aura offers discovery, authorization and access, never ownership of foreign config formats or workflows.
- **External protocols (MCP, …)** are reached through native abstractions (the Interface Registry), never protocol-specific top-level commands. An `aura interfaces` group comes only with a concrete need (none planned).
- **Specialized integrations, convenience automation and cross-app workflows** stay out of the core CLI. They may later ship as optional **Aura Power Tools**: own executables, Aura APIs only, the same authorization and approvals, distributed through Nexus / the Capability Store, never a dependency. The core CLI stays fully functional without them.
- **D109 CLI Skills stay in the core** (they describe native Aura operations and workflows) and stay agent-implementation-independent.
- A guideline, no alpha/beta work follows from it. **Reviewers reject new commands that cross this boundary.**
