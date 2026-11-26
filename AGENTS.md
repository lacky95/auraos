# AuraOS: repository AGENTS.md

This is the root of the instruction hierarchy for every coding agent and human working on the AuraOS repository. `AGENTS.md` is canonical; each sits next to a `CLAUDE.md` that contains only `@AGENTS.md`. (The file `os/home-seed/AGENTS.md` is different: it is the primer seeded into a *user's* home inside a running AuraOS, not guidance for this repository.)

| Level | File | Says |
|---|---|---|
| System | `AGENTS.md` (this file) | architecture, philosophy, principles, how to work |
| Kernel | `packages/core/AGENTS.md` | kernel sectors and their directories, kernel-wide invariants, the composition root |
| Layers outside the kernel | `packages/shell/AGENTS.md`, `packages/app-sdk/AGENTS.md`, `packages/aura-cli/AGENTS.md` | server layer and Web Shell, the app contract, the CLI client |
| Modules | e.g. `packages/core/src/app-manager/AGENTS.md`, `packages/shell/src/lib/access/AGENTS.md` | specifics, only where useful |

Higher levels state principles; lower levels the specifics. Don't repeat a rule at two levels: link to it.

**How agents find these files** (verified 2026-11-26):
- **Start your session at the worktree root.**
- **Claude Code** loads the root file at start, and loads each nested `CLAUDE.md` (with its `@AGENTS.md`) when it reads a file in that directory.
  - Started in a subdirectory, it loads every ancestor `CLAUDE.md`, but resolves the ancestors' `@AGENTS.md` only after a one-time approval of external imports. In `claude -p`, that approval is never given.
- **Codex** joins `AGENTS.md` from the git root down to the working directory and stops at 32 KiB. `pnpm arch` keeps every chain under 28 KiB.

## What AuraOS is (architecture in one screen)

A self-hosted WebOS for humans and their agents (`VISION.md`). One master container, `aura-shell`, runs the **Application Kernel** and its servers; apps run in sandboxes beside it.

```
Clients      Web Shell (packages/shell pages, components) · aura CLI (packages/aura-cli) · apps via SDK (packages/app-sdk)
Server       packages/shell: API routes, middleware, server/*.mjs (gateway, WS proxy, SSE), non-UI lib/
Kernel       packages/core: sectors Execution, Identity & Security, Resource, Communication, System Management, Foundation
ARI          runtime providers (container, PRoot) behind the runtime contract
Host infra   Docker, /data, Valkey (packages/kv-store)
```

- **A modular monolith** in Node.js/TypeScript through the alpha and beta (D97). No microkernel, no process per module, no universal RPC, no module framework.
- **The kernel works without presentation** (D73, D78): services start with no session, approvals never auto-approve without a client, and from Phase 6 the kernel boots eagerly with no Web Shell build.
- **Runtime-, shell- and agent-agnostic** (ARI, D73, D96): runtimes plug in behind ARI; the Web Shell is one client; no agent product's config enters the kernel.

## Philosophy

Simple by default. Modular by design. Replaceable by contract. Language-independent at meaningful boundaries. Agent-agnostic by design. Integrated as one system.

**Architectural integrity is as important as new functionality.** AuraOS is meant to be a large, long-lived, community-developed platform. Never trade a boundary for short-term convenience.

## Engineering principles (mandatory)

1. **Separation of concerns:** one responsibility per module; the kernel decides, the server transports, clients present.
2. **High cohesion, low coupling:** depend on few modules, and on their contracts.
3. **Explicit public contracts:** other modules use a module's declared entry points (`index.ts`, leaf `types.ts`/`contracts.ts`), never its implementation files. Contracts live in **leaf files** that import no other module at runtime.
4. **Dependency inversion where it pays:** pass collaborators in (constructor, `bootSystem()`); don't fetch them from a global.
5. **Clear state ownership:** each Valkey key prefix, file under `/data` and event type has one owning module. Others go through the owner's API. Never write another module's state.
6. **Encapsulation:** no reaching into another module's internals or private state.
7. **Controlled cross-sector dependencies:** follow the direction rules in `packages/core/AGENTS.md`.
8. **No unintended cycles:** between files, or between modules through real import chains.
9. **No uncontrolled global singletons:** no new `globalThis` pin. The existing ones are listed in `packages/core/AGENTS.md` and are created by the composition root.
10. **No presentation in the kernel:** no Web Shell, UI, Astro or React import, and no window or animation concepts in kernel sectors.
11. **Explicit composition:** wiring happens in one composition root (`bootSystem()`, Phase 6), not inside domain modules.
12. **Security, authorization and lifecycle invariants are preserved** by every change; a refactor never weakens one.
13. **Shared foundations stay minimal:** types, logger, the bus primitive, error codes. No grab-bag.

## Replaceability and language independence

- Design modules around **stable behavioural contracts** so a future implementation (for example in Rust) can replace a TS module and keep its contract, behaviour, security guarantees, state ownership, lifecycle semantics, error codes and dependents. It must pass the same contract and security tests (the ARI conformance kit is the model).
- At significant boundaries (ARI, providers, the HTTP API, events), pass **plain data**: no functions, class instances, `Map`s, emitters or internal state. Errors carry a stable `code`; don't make callers rely on `instanceof`.
- **Nothing speculative:** no serialization, RPC, native binding or process boundary without a concrete need. TS/Node through the beta; Rust only later, selectively, and by measurement.

## Rules for implementation agents

**Before you change a module, know:**
- its sector;
- its responsibilities;
- its public contracts;
- its allowed dependencies;
- the state it owns;
- its security invariants;
- the tests to run.

Read the `AGENTS.md` files from here down to the directory you work in.

- **Never bypass a boundary silently.** If the task conflicts with a boundary, a dependency rule or an ownership rule, stop and name the conflict, then propose a fix (a contract method, an event, a moved responsibility). Don't import around it, and don't add a baseline entry to make the check pass.
- **Changes need coordinated review** when they touch shared contracts (core exports, ARI, the manifest schema, the HTTP API, events), cross-sector dependencies or these principles.
- **Keep the docs true:** when you change a contract, a dependency rule or an ownership boundary, update the `AGENTS.md` that states it in the same commit. The docs explain why; the checks prevent violations.
- **Decisions are binding.** The D-numbers named in these files are owner decisions; don't reopen them in code.

## Validation

```sh
pnpm arch                               # architecture dependency check (tools/dep-check.mjs, D97)
node tools/dep-check.mjs --report       # module graph: sizes, fan-in and fan-out, cycles
node tools/run-tests.mjs --only=<pkg>   # unit, contract and golden suites (runs pnpm arch first; never in /workspace)
pnpm security                           # security gate
pnpm typecheck
```

- **`tools/dep-check.mjs`** enforces the import rules and that the docs match the code:
  - every `AGENTS.md` has a `CLAUDE.md` sibling that is exactly `@AGENTS.md`;
  - the kernel sector map in `packages/core/AGENTS.md` covers every core module.
- **Known violations** are in `tools/dep-baseline.json`, each with an owning phase. They must shrink. Only new violations fail.
- **System and VM testing** goes through the separate `auraos-e2e` repository (D95 levels L1–L5).

---

# Repository guide

pnpm monorepo. `packages/*` are the OS itself (shell, core, SDK, CLI, UI),
`apps/*` are the apps that run on it. The OS runs **inside a container** and
spawns each app as a sibling container or a PRoot process, so "the OS" and
"the thing you are editing" are the same working tree.

App-authoring docs live in `packages/aura-cli/src/templates/app/AGENTS.md`
(its `CLAUDE.md` is `@AGENTS.md`), the files `aura dev new` copies into every
scaffolded app. Edit them there; `apps/com.aura.{browser,docs,example}/CLAUDE.md`
are older copies.

## Running it

```sh
make up          # compose up: builds aura-base, then the shell (service aura-os → container aura-shell)
make restart     # restart the shell container
make logs        # follow shell logs (app logs are prefixed [<appId>])
make ps          # running aura-* containers
```

The shell serves `http://localhost:3000`. Each app is its own Astro dev server
on a port in 4001–4999, reached through `/api/proxy/<appId>/<path>`.

The compose project name defaults to the checkout's folder name, and the
volumes are named after it (`<project>_aura-app-data`), so they differ between
checkouts. Prefer `docker restart aura-shell` /
`docker exec aura-shell …` over `docker compose …` when acting on the shell
container specifically.

**You may be running inside `aura-shell` yourself.** Check `hostname` before
restarting it: restarting the container kills the agent session, and killing
the `astro dev` process does too (it's the entrypoint's foreground command, so
the container exits and `restart: unless-stopped` brings it back). Ask before
doing either.

## The build model — read this before debugging "my change did nothing"

`packages/*` are consumed as **compiled `dist/`**, not source (`"main":
"./dist/index.js"`). The container entrypoint builds every package once at
startup and then runs `astro dev`; the only watcher is `@aura/cli`. Nothing
recompiles a library while the OS is up.

So a source edit under `packages/` is invisible to the running OS until:

```sh
docker exec aura-shell pnpm --filter @aura/<pkg> build   # then restart the shell
```

Skipping this fails in ways that don't look like staleness:

- a shell route importing a new export → **500 on that route only**, because
  the module fails to import;
- a changed constant or regex → silently keeps the old value (e.g. adding a KV
  namespace to `KV_CONTEXT_NAMESPACE_PATTERN` has no effect, so writes to the
  new namespace are rejected as invalid);
- a runner change (`ContainerRunner`, `ProotRunner`) → applies only to apps
  spawned *after* the restart.

What does **not** need a rebuild: `packages/shell`'s own pages, API routes and
middleware (it runs under `astro dev`), and everything in `apps/*` — those are
bind-mounted and re-read on iframe reload. Their imports of `@aura/core` still
come from `dist`.

## Verifying changes

There is no browser automation in this repo — UI changes are verified at the
desktop by hand. Where a check can be made without a browser, prefer it:
fetching a page through the proxy (`http://localhost:3000/api/proxy/<appId>/<page>`)
and asserting on the HTML catches most of it, and cross-checking every
`var(--aura-color-*)` name against `/api/os/theme.css` catches invented tokens
and leftover hardcoded colours.

Type checks and unit tests:

```sh
pnpm typecheck                        # recursive
pnpm --filter @aura/core test         # + @aura/kv-store test
```

## Styling

The styling rules (classes vs `data-*`, `is:global` for injected rows, Tailwind `@source`, the closed set of theme tokens) are in `packages/shell/AGENTS.md`. They apply to the Web Shell and to every app's UI.

## Data, state, persistence

- `/data` is the only writable persistent tree (`AURA_DATA_DIR`). `/workspace`
  is the bind-mounted repo. Everything else is rebuilt from the image.
- App scopes, in registry priority order: `system` = `/workspace/apps` (the
  in-repo apps), `global` = `/data/scopes/global/apps`, `user` =
  `/data/scopes/users/default/apps`. `aura dev new` targets user/global.
- Aura Context: env/secrets via `ContextStore` (sealed in KV, materialised to
  `/run/context`), shared volumes via `VolumeStore` under
  `/data/context/volumes/<name>`. Both are server-internal — the public
  `/api/kv/...` proxy rejects the `context:*` namespaces; use `/api/os/context`
  and `/api/os/volumes`.
- KV namespaces are validated by regex in `packages/kv-store/src/types.ts`. A
  new namespace is a code change plus a rebuild, not just a new key.

## Conventions

- TypeScript strict, ES modules.
- Reverse-domain app ids; the app's directory name must equal `manifest.id`.
- Class names are for styling, `data-*` attributes are for JS hooks.
- After a write, render the row from the response you already have; treat the
  follow-up list GET as reconciliation, and never swallow its failure with a
  bare `if (!res.ok) return`. Silent `return`s on a failed refresh look exactly
  like "the feature doesn't work".
- Apps are cooperating, not adversarial: PRoot is a filesystem sandbox, not a
  security boundary.

## Where things live

```
packages/core         AppManager, ProotRunner, ContainerRunner, OsEventBus,
                      PermissionManager, ThemeManager, ContextStore/VolumeStore,
                      manifest schema
packages/shell        Astro SSR shell — /api/proxy, /api/os/*, /api/apps,
                      /api/data, middleware (OS bootstrap), layout + launcher
packages/app-sdk      OsClient, lifecycle factories, auraAppIntegration
packages/kv-store     Valkey-backed KV + namespace validation
packages/aura-cli     the `aura` CLI, and the app template it scaffolds from
packages/ui           shared UI primitives (React/scificn) + theme bridge
apps/<id>             apps shipped with the OS
os/                   entrypoint shims, bashrc, publish scripts
```

Start points when stuck: `packages/shell/src/middleware.ts` (what boots on
first request), `packages/core/src/app-manager/` (how apps are spawned),
`packages/shell/src/pages/api/proxy/[id]/[...path].ts` (how app HTML/JS is
rewritten for the iframe).
