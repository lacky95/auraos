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

```
aura ps                    list running instances
aura status                summary of OS health
aura app  …                manage apps        (list/info/start/stop/restart/install/remove)
aura inst …                manage instances   (list/info/stop/kill/pause/resume/shell/logs)
aura activity …            manage activities  (list/open/close)
aura cap  …                manage capabilities (list/install/remove/grant/revoke/info/registry)
aura service …             manage daemons     (list/install/start/stop/status/logs/uninstall)
aura dev  …                developer tools    (new/validate/standalone)
aura theme …               OS theme           (list/get/set)
aura data …                content providers  (query/write/watch)
aura events                follow OsEventBus
aura completion <shell>    print shell completion script
```

`--shell-url <url>` overrides the default `http://localhost:3000` for any
command that talks to the shell. You can also set `AURA_SHELL_URL`.

## Verification — End-to-End

### Status & Lifecycle

1. `aura status` — prints shell URL, app counts, capability count, paths.
2. `aura ps` — empty table when nothing is running.
3. `aura app start com.aura.terminal` — returns `com.aura.terminal-1`, exit 0.
4. `aura ps` — one row: `terminal-1`, state=`resumed`, port=`4001`.
5. `aura inst info com.aura.terminal-1` — full status (manifest + state + activities).
6. `aura inst stop com.aura.terminal-1` — `ps` table is empty again.

### Capabilities

7. `aura cap list` — entries from the built-in registry; only `aura` and `claude` start out as installed.
8. `aura cap install ripgrep` — `apt-get install ripgrep` → symlinks `/os/toolchain/bin/rg`. `aura cap list` now shows `rg` installed=`✓`.
9. `aura cap grant com.aura.terminal ripgrep` — adds `"rg"` to the terminal manifest's `tools` array; running instances are restarted automatically.
10. `aura app start com.aura.terminal` — `terminal-1` running.
11. `aura inst shell com.aura.terminal-1` — drops you into the PRoot of that instance. `which rg` → `/usr/local/bin/rg`, `rg --version` works.
12. `exit` — back on the master.
13. `aura cap revoke com.aura.terminal ripgrep` — removed from the manifest.

### Services

14. `aura service install sshd` — `apt-get install openssh-server`.
15. `aura service start sshd` — daemonised; PID stored in `/data/aura/state/services/sshd.pid`.
16. `aura service status sshd` — running, port `2222`.
17. From the docker host: `ssh -p 2222 root@localhost` connects.
18. `aura service stop sshd` — cleans up.

### Dev

19. `aura dev new com.aura.demo` — scaffolds a new app under `apps/com.aura.demo/` with a valid manifest.
20. `aura dev validate apps/com.aura.demo` — zero errors against the AuraOS schema.
21. `aura app install apps/com.aura.demo` — `app:installed` broadcast.
22. `aura app start com.aura.demo` — starts (assuming `entrypoint.sh` is good).

### OS Wrapper

23. `aura theme get` → `scificn`.
24. `aura theme set amber` → 200; the browser shell switches to amber live (SSE-driven).
25. `aura theme get` → `amber`.
26. `aura data query com.aura.settings/api/data/settings` → settings JSON.
27. In a second terminal: `aura events` → live timeline.
28. In the first terminal: `aura app start com.aura.counter` → the event stream shows `app:stateChanged` events.

### PRoot Forward of the CLI

29. `aura cap grant com.aura.terminal aura` (already seeded by default).
30. `aura inst shell com.aura.terminal-1` → inside the sandbox, `aura ps` shows the same table as on the master.

### Cleanup & Resilience

31. `aura cap remove ripgrep` — uninstall + cleanup symlinks.
32. Container restart → `aura cap list` still shows installed capabilities (state persisted to `/data/aura/state/capabilities.json`).

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
| `AURA_USE_PROOT`        | `true` (in docker-compose)              | Whether `inst shell` enters a PRoot or runs raw     |
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
