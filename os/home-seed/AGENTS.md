# AuraOS — agent primer

You are running inside **AuraOS**, inside the Terminal app (`com.aura.terminal`). This is the onboarding file AuraOS ships with. Use it when the user asks what Aura is, how to use it, or wants to do something with it. Treat the `aura` CLI as the source of truth: `aura --help` and `aura <command> --help` are always current, and this file is only a map.

## What AuraOS is

AuraOS is a WebOS for humans and their agents. It is a desktop that runs in the browser.

- **The shell** is the master container, `aura-shell`. It hosts the API and window manager at `$OS_API_BASE`.
- **Apps** run in sandboxes. A sandbox is either a PRoot (lightweight) or a container (full Docker).
- **Windows** show apps on the desktop. This terminal is itself one of those apps.
- **`~` (`/home/aura`) is one home shared by every app.** A `claude` or `codex` login, your git config and your dotfiles follow you into every app you jump into.
- **`/data` persists.** Everything outside `/data` and `~` inside a sandbox is throwaway.

## When the user asks "what is Aura?"

1. Explain it in a few sentences using the section above.
2. Offer a short **tour** of *their* live system. Run these read-only commands and explain what comes back, instead of describing a system you haven't looked at:
   - `aura status`: health and counts
   - `aura get apps`: installed apps
   - `aura ps`: what is running
   - `aura get caps`: tools that can be shared
   - `aura get iface`: MCP servers and other interfaces apps provide
3. Offer next steps from **Things you can do** below. Building their first app with `aura dev new` is the usual favourite.

## Concepts

| Term | Meaning |
|---|---|
| **App** | A directory with an `app.manifest.json`. Its id is reverse-domain, e.g. `com.example.notes`. Each app is an Astro web app plus lifecycle endpoints. |
| **Instance** | A running copy of an app. `instanceMode` is `single` or `multi`. |
| **Activity** | A window that shows an instance. |
| **Sidecar** | An extra container next to an instance, such as a database, an agent or a foreign image. Sidecars are declared in the manifest's `services[]`. |
| **Scope** | Where an app is installed. `system` holds the built-in apps and can't be changed. `global` is `/data/scopes/global`. `user` is `/data/scopes/users/default`. Your apps go in `user`, and a `user` app with the same id shadows the `global` one. |
| **Capability (cap)** | A shared CLI tool (`git`, `claude`, `ripgrep` …) from the capability registry. Apps only see the caps they were granted, at `/aura/my-tools`. |
| **Permission (perm)** | A manifest permission, e.g. `apps.mount`. Manage them with `aura get perms`, `aura grant perms` and `aura revoke perms`. |
| **Nexus** | The app store. It aggregates OCI registries and git catalogs. |
| **Interface** | Something an app provides to others, such as an MCP server, a REST/HTTP endpoint or a WebSocket. The Interface Registry lists all of them (see "Finding out more"). |

## The `aura` CLI

The grammar is kubectl-style: `aura <verb> <resource> [name]`. Short resource names are `app inst sc act cap svc mount port scope theme perm`.

- To look at things, use `get` and `describe`, with `-o wide|json|yaml|name`. Use `logs inst <i> [-f]` for output and `events` for a live stream of changes.
- To change state, use `start|stop|restart app|inst|svc`, `pause|resume inst`, `enable|disable app` and `rm …`.
- Tab completion: `eval "$(aura completion bash)"`.

## Things you can do

**Create an app.** Run `aura dev new` to start the wizard. To script it instead:
`aura dev new com.example.hello --name Hello --shape activity --sandbox container --tools git,claude --non-interactive`

- **Shapes:** `activity` (a window), `activity-bg` (a window that keeps running), `service` (headless).
- **Runtime:** omit `--sandbox` to follow the default runtime (`container`; `aura runtime ls`), or name one (`container`, `proot`).
- **Scope:** `user` (default) or `global`.
- **Every new app gets its own `AGENTS.md`** (and a one-line `CLAUDE.md` that loads it). Read it before changing that app.
- **Related:** `aura dev clone` (copy any app, system ones included), `aura dev validate` and `aura dev standalone <app>` (fast UI iteration).

**Grant and manage capabilities.**
- Look: `aura get caps`, `aura cap ls`, `aura cap info <tool>`.
- Install: `aura install cap` (picker) or `aura cap install <tool…>`.
- Grant: `aura cap grant` (picker) or `aura grant caps <app> <tool…>`. Use `'*'` to grant every tool.
- Revoke: `aura revoke caps <app> <tool…>`.
- Grants reach running instances without a restart. If a tool installs but won't run, use `aura cap doctor`.

**Mount another app's files live.**
- `aura mount` opens a wizard.
- `aura mount <app…>` (or `aura mount add <app…>`) attaches files; add `--wr` to make them writable. `--wr` is refused for a closed install (see "Working on Aura apps").
- `aura mount <app> --patches` attaches the app's patch repository at `/mnt/aura/patches/<appId>` (writable; one per installation, shared by all your Terminals).
- `aura mount ls` and `aura mount rm` show and detach mounts of every kind: source, data, patches and work (patch workspaces).
- Mounts are read-only by default and need no restart.
- They only work in container sandboxes, and the target app needs the `apps.mount` permission.

**Jump into any app.**
- `aura jump` opens a picker.
- `aura jump <app|inst>` gives you a shell inside that sandbox.
- `aura jump <app> --sidecar <name>` goes into a sidecar.
- `aura jump -m` goes into the master container.
- Your home and logins come with you, so `claude` works over there too.

**More:**
- Run apps: `aura run <app>`, `aura open inst <i>`, `aura exec inst <i> -- <cmd>`.
- Ports: `aura port expose <app:port>` connects an app's port to another app or to the host.
- Data: `aura data query|write|watch <ref>` reads and writes app content providers.
- Store: `aura nexus search <q>`, `aura nexus app …` to install, update and publish.
- Themes: `aura get themes`, `aura set theme <name>`.

<!-- aura:section working-on-aura-apps -->
## Working on Aura apps

**To work on an app, run `aura dev status <app>` and use the paths it prints.** `<app>` is the app's id or its name. It works from any Terminal, without Docker.

- **Read the source** at `/mnt/aura/<appId>`. `status` binds it into this Terminal.
- **A closed install** (the default for installed apps, and always for system apps) is read-only. A write fails with "Read-only file system". That is expected: don't work around it.
- **To change a closed app**, use a patch workspace:
  1. `aura dev patch start <app>` gives you a writable copy at `/mnt/aura/work/<appId>`: your existing workspace of that app if you have one (from any Terminal), else a fresh one (`--new` always starts fresh). Workspaces are made only this way. Edit and test there.
  2. `aura dev patch save` saves your change as a versioned patch into the app's patch repository (`/mnt/aura/patches/<appId>`, shared by all your Terminals).
  3. To try it first: `aura dev patch preview` runs your workspace as a separate "Preview" instance in its own window, on a copy of the app's data (the installed app is untouched, nothing is installed); `--stop` ends it.
  4. `aura dev patch activate` installs it. The owner approves it in the desktop; the previous version is kept for rollback.
- **Built-in apps** (Settings, Terminal, …) are read-only: you can read their source. They are patched by system patches (Phase 7) or in Developer Mode; to change an app now, use a normal app (installed from Nexus, or your own) or Developer Mode.
- **An open install** (the owner ran `aura dev open <app>`) and **your own apps** (`aura dev new`) are writable: `status` prints the writable path.
- Never open an app yourself to make a change easier. Opening is the owner's decision.
- Upstream updates keep your patches: `aura dev update <app>`. If a patch no longer applies, the working version keeps running and the patch is marked "needs repair" (you also get a notification naming the patch, the files and the repair command).
- Old patch workspaces pile up: `aura dev patch clean [app]` deletes all but the bound one and the newest three (`--keep N`).
<!-- /aura:section working-on-aura-apps -->

## Finding out more: docs and interfaces

**The Aura Docs app** (`com.aura.docs`) has the full guides: core concepts, developing an app, sidecars, mounts, scopes, interfaces, the CLI reference and deep dives. Users open it from the launcher. Agents use its MCP server, which has the tools `list_docs`, `search_docs` and `get_doc`. Search the docs before answering anything this file doesn't cover.

**The Interface Registry** is the OS's phone book. Apps declare what they **provide** in their manifest (`provides[]`): MCP servers, REST/HTTP endpoints and WebSockets. It reflects the system as it is right now, so look there instead of guessing which MCP servers or APIs exist. Each entry has:
- **`status`:** `live` (running, the URL works), `catalog` (installed but not running) or `down` (starting or dying).
- **`url`:** relative to `$OS_API_BASE`.
- **`description`:** what it offers.

You can read it three ways:
- **With the CLI.** `aura get iface` (`-a <app>` filters, `-o wide` adds the description, `-o json` everything).
- **Over HTTP.** Every MCP server: `curl -s -H "Authorization: Bearer $AURA_INSTANCE_TOKEN" "$OS_API_BASE/api/interfaces?kind=mcp&consumers=0"`. Everything: drop `kind`. Filters are `kind`, `appId`, `name` and `live=1`. Leave out `consumers=0` to also get the dependency report (`live` / `installed` / `unmet`).
- **Over MCP.** `com.aura.settings` provides an MCP server for the registry itself at `$OS_API_BASE/api/proxy/com.aura.settings/mcp/interfaces`. Its tools are `list_interfaces`, `resolve_interface`, `get_interface` and `list_consumers`.

Humans browse the same registry in Settings → Interfaces.

**Connect an MCP server you found.** Any MCP client works the same way: the endpoint is `$OS_API_BASE` + the entry's `url`, and every call sends `Authorization: Bearer $AURA_INSTANCE_TOKEN` (see below). Offer to add it in the client the user works with. New installs preconfigure the docs and the registry servers, as `aura-docs` and `aura-interfaces`, for the two clients the Terminal ships (Claude Code, Codex); on an older install, or if they're missing, add them like any other server.

<!-- aura:section mcp-token-by-reference -->
**Calls to the shell carry your session credential, by reference, never by value.** `$AURA_INSTANCE_TOKEN` is the credential AuraOS gives this session (each app instance, this Terminal included, has its own); it is not the internal lifecycle token the shell uses to drive an app. Every call through the shell (`$OS_API_BASE/api/proxy/…`, `$OS_API_BASE/api/…`) sends `Authorization: Bearer $AURA_INSTANCE_TOKEN`. Calls without it are refused once release 5-main is in.
- A client config names the *variable*, never its value: `~` is shared by every app, so a token written there would let all of them act as you, while the reference gives each app its own. Never print the token or paste it into a file.
- `curl`: `-H "Authorization: Bearer $AURA_INSTANCE_TOKEN"` (double quotes: expanded in your shell, never stored).
- Examples for two clients (any client that reads a header from the environment works the same way):
  - Claude Code (single quotes, so the shell does not expand it): `claude mcp add --scope user --transport http aura-docs '${OS_API_BASE}/api/proxy/com.aura.docs/mcp' -H 'Authorization: Bearer ${AURA_INSTANCE_TOKEN}'`.
  - Codex: `codex mcp add aura-docs --url "$OS_API_BASE/api/proxy/com.aura.docs/mcp" --bearer-token-env-var AURA_INSTANCE_TOKEN` (in `config.toml`: `bearer_token_env_var = "AURA_INSTANCE_TOKEN"`).
- Older Claude Code or Codex entries without the token (or with a token written in): the optional adapter `node ~/.aura/adapters/mcp-clients.mjs ls` shows them (never a value) and `… fix` moves them to the reference, with a backup and the owner's yes at the terminal. It is a plain script in your home: edit, replace or delete it.
<!-- /aura:section mcp-token-by-reference -->

Your own app can show up in the registry too: add `provides[]` to its manifest (see the docs page "Interfaces").

## Working safely

- Explore with read-only commands (`get`, `describe`, `logs`, `status`).
- Confirm with the user before `rm`, `revoke`, `disable`, `kill` and `stop`. Stopping `com.aura.terminal` ends the session you are running in.
- Use `aura start|stop|restart` to control apps. Plain `docker restart` drops an instance from AuraOS.
- Grants, API keys, the audit trail, manifest edits and installs are the owner's. From this Terminal they ask for approval in the desktop and the command waits; tell the user to approve it there. There is no admin login. On the host (`docker exec -it aura-shell aura …`) they run directly.

## Your notes

AuraOS creates this file only if it is missing, so it is yours to edit. Add your own conventions below. When AuraOS ships a new section (between `<!-- aura:section … -->` markers), it appends that section once and leaves the rest of the file alone.
