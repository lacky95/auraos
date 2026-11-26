# Test baseline

> **Superseded as the live record (D95):** the current known failures (package suites, `astro check`, e2e) are kept in the auraos-e2e repo, `docs/known-failures.md`. This file is the dated Phase 0 snapshot. Architecture dependency debt (D97) is in `tools/dep-baseline.json` (`pnpm arch`).

| | |
|---|---|
| **Commit** | The Phase 0 review-fix commit on `phase0/baseline`, based on `e2f3664` (no product code changed from `6e4a797`) |
| **Date** | 2026-11-23 |
| **Node** | v22.23.5 |
| **Where** | Git worktree inside the `aura-shell` master container |
| **Command** | `pnpm test` (`node tools/run-tests.mjs`) |

## Results

| Suite | Files | Tests | Pass | Fail | Skip | Result |
|---|---:|---:|---:|---:|---:|---|
| `packages/core` | 35 of 36 | 428 | 415 | 13 | 0 | fail |
| `packages/shell` | 37 | 340 | 340 | 0 | 0 | pass (forced exit, see below) |
| `apps/com.aura.terminal` | 29 | 183 | 162 | 0 | 21 | pass |
| `packages/app-sdk` | 3 | 21 | 21 | 0 | 0 | pass |
| `apps/com.aura.aurashelld` | 3 | 47 | 47 | 0 | 0 | pass |
| `packages/aura-cli` | 2 | 20 | 19 | 1 | 0 | fail |
| `apps/com.aura.console` | 2 | 15 | 15 | 0 | 0 | pass |
| `packages/kv-store` | 1 | 16 | 16 | 0 | 0 | pass |
| **Total** | **112 of 113** | **1070** | **1035** | **14** | **21** | |

## Existing failures

None of these were fixed.

**`packages/core`: stale test fake (12).** `test/intent-dispatch.test.mjs` runs `AppManager` methods against a fake `this` that lacks the private `allocateActivityId`, so each fails with `this.allocateActivityId is not a function`:

- multi-activity app: onActivityCreate keeps data=extras and adds the whole intent
- plain openActivity (no intent) sends no intent field — old contract intact
- default launch mirrors the launcher: defaultLaunch 'new-activity' reuses the first user-owned instance
- default launch with no user-owned instance → start() (pool claim / spawn)
- defaultLaunch 'new-instance' keeps start() semantics (a fresh instance each time)
- instanceId targets exactly that instance and resumes it when paused
- NEW_INSTANCE starts a fresh instance even when one could be reused
- onActivityCreate rejection → no activity, kind rejected, existing instance kept
- rejection on an instance started only for this intent stops it again
- noActivity reply → handled window-less: no activity registered, result handed back
- result from a window-opening onActivityCreate is returned alongside activityId
- plain openActivity ignores rejected/noActivity (only intent launches may decline a window)

**`packages/core`: master container environment (1).**

- `PortAllocator refuses ports that are bound at the OS level`: the test binds fixed port 4001, which a live process already holds here (`EADDRINUSE`).

**Environment-dependent, passed in this run.**

- `killProcessGroup terminates detached descendants, not just the root`: it can fail in the master container, because PID 1 does not reliably reap orphans and the test counts a zombie as alive. It failed in the first baseline run and passed in this one, so a failure here is not by itself a regression.

**`packages/aura-cli` (1).**

- `main help: every visible command is listed, plus every resource short name; no legacy group`: the visible `build` command is missing from the main help.

## Core test not added to the list

`packages/core/test/layout-registry.test.mjs` (5 of 6 pass) stays out of the `test` script. `singleton seeds tiling, fullscreen, stack` expects three layouts, but the registry also has `rows`. The other three unlisted files passed and were added: `app-build` (4), `keymap-canonical` (16), `topic-filter` (8).

## Skipped or not run

- **21 Terminal tests skipped.** They need real `tmux`, which is not installed in the master container.
- **No suite was withheld as unsafe.** Each was inspected first. Tests that call Docker use mocks or stubs.
- **`packages/aura-cli/test/smoke.sh` not run.** It is not part of the CLI `test` script and bypasses the smoke guard, so it is a separate manual check in `tools/smoke/MANUAL.md`.

## Known test-harness issue

`packages/shell/test/app-hosts.test.ts` passes all 9 tests, but its process never exits, so the suite hangs. The likely cause is an upgraded socket left open after `server.close()` (not confirmed). `tools/run-tests.mjs` passes `--test-force-exit` for `packages/shell` until this is fixed. Plain `pnpm --filter @aura/shell test` still hangs.

## Isolation

`tools/run-tests.mjs` refuses to run from `/workspace` unless `--allow-live-workspace` is passed. Each suite gets a temporary data directory and home, no inherited `AURA_*`, `OS_API*`, `DOCKER_*`, or `TMUX*` variables, a `docker` stub that always fails, and a Node preload that blocks the Docker socket, port 3000, every port already listening on loopback when the run starts (read from `/proc/net/tcp` and `/proc/net/tcp6`), and non-loopback hosts. Ports the tests open later stay usable. The guard recorded no blocked attempts in this run.

The guard does not sandbox the filesystem or block every process. `updater-script.test.mjs` creates and removes `/tmp/rebuilt`, `/tmp/restarted`, and `/tmp/rebased`. Run the suite only from a worktree.

## Typecheck

`packages/shell` typecheck at this baseline reports 6 errors, none in Phase 0 files. Two are `@aura/ui` imports because the worktree has no `packages/ui/dist`. Four are existing test type errors in `test/app-hosts.test.ts` and `test/desktop-ssr-slots.test.ts`.
