# `aura` CLI

Control AuraOS and developer workflow from a single command. Wraps the shell's
HTTP API (app lifecycle, activities, content providers, events) and adds
master-side concerns: shareable **capabilities** that get bind-mounted into
PRoot sandboxes, long-running **services** (sshd, code-server, …), and a
scaffolder for new apps.

## Install

The CLI ships with AuraOS. The Dockerfile builds
`packages/aura-cli/dist/aura.cjs` and symlinks it to:

- `/usr/local/bin/aura` — on the master `$PATH`
- `/os/toolchain/bin/aura` — bind-mountable into PRoots as the `aura` capability

To build manually:

```sh
pnpm --filter @aura/cli build
```

Local dev (tsx watch, no build needed):

```sh
pnpm --filter @aura/cli dev -- <args>
```

## Overview

Short forms for everyday work, kubectl-style verbs for everything else:
`aura <command> [resource] [name...] [flags]`. `aura --help` prints the same
sections as below (each line is checked against the command tree by the
tests); `aura <command> --help` shows one command's resources, flags and
examples. The full reference is the docs page *CLI Reference*.

```
Basics           aura ps · run <app> · jump [app|inst] [--sidecar <name>] · status · info · dev new
Inspect          aura get apps|inst|sidecars|act|caps|svc|mounts|ports|scopes|themes|perms [name]
                 aura get inst <name> sidecars · describe <resource> <name>
                 aura logs inst <name> -c <sidecar> · logs svc <name> · events
                 (get: -o wide|json|yaml|name  -a <app>  -i <inst>  -w  --no-headers)
Lifecycle        aura start|stop|restart app|inst|svc <names...>
                 aura pause|resume|kill inst <inst...> · enable|disable app <app...>
Install & remove aura install app <dir> | cap [names...] | svc <name> | sdk
                 aura rm app|act|svc|cap|mount|port <names...>   (rm = delete)
Connect          aura exec inst <name> [-c <sidecar>] [-- <cmd...>] · open inst <name>
                 aura mount ... · port ... · data ...
Access           aura grant|revoke perms|caps <app> [names...] · cap ...
Ecosystem & dev  aura nexus ... · dev ...
Settings         aura set theme <name> · completion bash|zsh · api-resources

Short names: app inst sc act cap svc mount port scope theme perm
```

The previous groups (`aura app …`, `aura inst …`, `aura activity …`,
`aura service …`, `aura theme …`, `aura scope …`, `aura sdk …`,
`aura whereami`) still work but are hidden; on a TTY they print a one-line
hint with the new form (`AURA_DEPRECATION_HINTS=0` silences it).

`--shell-url <url>` overrides the shell URL for any command (default
`$OS_API_BASE`, else `http://127.0.0.1:3000`). You can also set `AURA_SHELL_URL`.

## Layout

```
src/index.ts            entry: buildProgram().parseAsync()
src/program.ts          the command tree, main help, completion
src/commands/verbs.ts   kubectl verbs; mutating ones re-run the classic group on a fresh program
src/lib/resources.ts    resource registry (names, columns, list functions)
src/lib/output.ts       -o table|wide|json|yaml|name
src/lib/resolve.ts      app id / instance id / prefix → instance; sidecar ids
src/lib/deprecate.ts    hidden legacy groups + hints
test/                   `pnpm --filter @aura/cli test` (unit), `sh test/smoke.sh` (live, read-only)
```

## Verification — End-to-End

### Status & Lifecycle

1. `aura status` — prints shell URL, app counts, capability count, paths.
2. `aura ps` — empty table when nothing is running.
3. `aura run com.aura.terminal` — returns `com.aura.terminal-1`, exit 0.
4. `aura ps` — one row: `terminal-1`, state=`resumed`, port=`4001`.
5. `aura describe inst com.aura.terminal-1` — full status (manifest + state + activities, sidecars, mounts).
6. `aura stop inst com.aura.terminal-1` — `ps` table is empty again.

### Capabilities

7. `aura get caps` — entries from the built-in registry; only `aura` and `claude` start out as installed.
8. `aura install cap ripgrep` — `apt-get install ripgrep` → symlinks `/os/toolchain/bin/rg`. `aura get caps` now shows `rg` installed=`✓`.
9. `aura grant cap com.aura.terminal ripgrep` — adds `"rg"` to the terminal manifest's `tools` array; running instances are hot-refreshed (no respawn).
10. `aura run com.aura.terminal` — `terminal-1` running.
11. `aura jump com.aura.terminal-1` — drops you into that instance's sandbox. `which rg` → `/usr/local/bin/rg`, `rg --version` works.
12. `exit` — back on the master.
13. `aura revoke cap com.aura.terminal ripgrep` — removed from the manifest; running instances restart.

### Services

14. `aura install svc sshd` — `apt-get install openssh-server`.
15. `aura start svc sshd` — daemonised; PID stored in `/data/aura/state/services/sshd.pid`.
16. `aura describe svc sshd` — running, port `2222`.
17. From the docker host: `ssh -p 2222 root@localhost` connects.
18. `aura stop svc sshd` — cleans up.

### Dev

19. `aura dev new com.aura.demo` — scaffolds a new app under `apps/com.aura.demo/` with a valid manifest.
20. `aura dev validate apps/com.aura.demo` — zero errors against the AuraOS schema.
21. `aura dev clone com.aura.counter com.aura.demo2 --scope user` — copies the app server-side, rewrites the manifest id + package name, ports `@aura/*` deps to `auraDependencies`, and lands it in the user scope.
22. `aura install app apps/com.aura.demo` — `app:installed` broadcast.
23. `aura run com.aura.demo` — starts (assuming `entrypoint.sh` is good).

### OS Wrapper

24. `aura get themes` → the ACTIVE column marks the theme in use per tone slot.
25. `aura set theme amber` → 200; the browser shell switches to amber live (SSE-driven).
26. `aura get themes` → `amber` marked ACTIVE (`dark`).
27. `aura data query com.aura.settings/api/data/settings` → settings JSON.
28. In a second terminal: `aura events` → live timeline.
29. In the first terminal: `aura run com.aura.counter` → the event stream shows `app:stateChanged` events.

### PRoot Forward of the CLI

30. `aura grant cap com.aura.terminal aura` (already seeded by default).
31. `aura jump com.aura.terminal-1` → inside the sandbox, `aura ps` shows the same table as on the master.

### Cleanup & Resilience

32. `aura rm cap ripgrep` — uninstall + cleanup symlinks.
33. Container restart → `aura get caps` still shows installed capabilities (state persisted to `/data/aura/state/capabilities.json`).

## Capabilities — `/workspace/.aura/capabilities.yaml`

The registry is a single YAML file. The built-in defaults are seeded on the
first `aura cap …` call. Edit the file to add custom capabilities, or use
`aura cap registry add` for the common cases.

Sources:

- **apt** — `apt-get install <package>`, then symlink the binary into `/os/toolchain/bin/`.
- **npm** — `npm install -g <package>`, then symlink.
- **curl** — either a one-shot `install_cmd` (e.g. `curl … | bash`) or `url` + `extract` (`tar` / `zip`) for download-and-unpack.
- **builtin** — no install step; the binary already exists (used for `aura` itself).

State for "which is installed" lives in `/data/aura/state/capabilities.json` so
it survives container restarts.

### Shared libraries

A capability is not always one file, and not always self-contained. `apt-get
install` runs in the shell container, so a dynamically-linked cap's `.so` files
land in the *shell's* `/usr/lib` — an app sandbox has never seen them. Install
therefore resolves the binary's `ldd` graph and stages every non-baseline
library into a lib store beside the binaries (`/os/toolchain/lib` and its
volume mirror), records them per owner in `.libs.json`, and copies them into
`/os/base-rootfs` at their original paths for PRoot.

Granting a tool then materialises just that tool's libraries into the
instance's `/aura/my-tools/.lib`, which is on `LD_LIBRARY_PATH`. So libraries
follow the grant, not the whole toolchain.

`aura cap doctor` checks the result by running `ldd` inside a throwaway app
container and a throwaway PRoot — the sandboxes apps really use — so a cap that
installs cleanly and dies at exec with "cannot open shared object file" shows up
as a row rather than as a bug report. `--fix` re-stages the broken ones without
re-running apt.

## Services

Daemons live in the master namespace (not inside a PRoot) because sshd and
code-server need direct host access. The CLI manages them through a registry
entry + PID file in `/data/aura/state/services/<name>.pid`.

## Environment Variables

| Variable                | Default                                 | Purpose                                             |
|-------------------------|-----------------------------------------|-----------------------------------------------------|
| `AURA_SHELL_URL`        | `http://localhost:3000`                 | Where the CLI sends HTTP calls                      |
| `AURA_APPS_DIR`         | `/workspace/apps`                       | Where app directories live                          |
| `AURA_DATA_DIR`         | `/data`                                 | Persistent data root                                |
| `AURA_BASE_ROOTFS`      | `/os/base-rootfs`                       | PRoot rootfs                                        |
| `AURA_TOOLCHAIN_DIR`    | `/os/toolchain`                         | Shared toolchain root                               |
| `AURA_USE_PROOT`        | `true` (in docker-compose)              | Whether `jump`/`exec` enter a PRoot or run raw      |
| `AURA_REGISTRY_PATH`    | `/workspace/.aura/capabilities.yaml`    | Override the registry file location                 |
| `AURA_STATE_PATH`       | `/data/aura/state/capabilities.json`    | Override the state file location                    |
| `AURA_TEMPLATE_DIR`     | `…/aura-cli/src/templates/app`          | Override the `aura dev new` scaffold template       |

## Architecture Notes

- **HTTP first**: the CLI runs as a separate process from the Astro SSR shell.
  The `AppManager` singleton is pinned on `globalThis` inside the shell, but
  not in the CLI process, so all lifecycle commands talk to the shell over
  HTTP. Filesystem operations (manifest edits, capability install, scaffold)
  happen directly.
- **Single-file bundle**: `esbuild` bundles everything (including `@aura/core`,
  `commander`, `yaml`, the registry-defaults YAML inlined via the `text`
  loader) into `dist/aura.cjs`. That is the file symlinked into `PATH` and
  into the toolchain.
- **PRoot forward**: when an app declares `"aura"` in its `tools`, the
  ProotRunner bind-mounts `/os/toolchain/bin/aura → /usr/local/bin/aura` into
  the sandbox. Inside, `aura …` works the same — calls back to the shell over
  HTTP using `OS_API_BASE`.
