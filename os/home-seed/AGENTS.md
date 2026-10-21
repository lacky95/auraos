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
   - `curl -s "$OS_API_BASE/api/interfaces?kind=mcp&consumers=0"`: MCP servers apps provide
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
- **Sandbox:** `proot` (default) or `container`.
- **Scope:** `user` (default) or `global`.
- **Every new app gets its own `CLAUDE.md`.** Read it before changing that app.
- **Related:** `aura dev clone` (copy any app, system ones included), `aura dev validate` and `aura dev standalone <app>` (fast UI iteration).

**Grant and manage capabilities.**
- Look: `aura get caps`, `aura cap ls`, `aura cap info <tool>`.
- Install: `aura install cap` (picker) or `aura cap install <tool…>`.
- Grant: `aura cap grant` (picker) or `aura grant caps <app> <tool…>`. Use `'*'` to grant every tool.
- Revoke: `aura revoke caps <app> <tool…>`.
- Grants reach running instances without a restart. If a tool installs but won't run, use `aura cap doctor`.

**Mount another app's files live.**
- `aura mount` opens a wizard.
- `aura mount add <app…>` attaches files; add `--wr` to make them writable.
- `aura mount ls` and `aura mount rm` show and detach mounts.
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

## Finding out more: docs and interfaces

**The Aura Docs app** (`com.aura.docs`) has the full guides: core concepts, developing an app, sidecars, mounts, scopes, interfaces, the CLI reference and deep dives. Users open it from the launcher. Agents use its MCP server, which has the tools `list_docs`, `search_docs` and `get_doc`. Search the docs before answering anything this file doesn't cover.

**The Interface Registry** is the OS's phone book. Apps declare what they **provide** in their manifest (`provides[]`): MCP servers, REST/HTTP endpoints and WebSockets. It reflects the system as it is right now, so look there instead of guessing which MCP servers or APIs exist. Each entry has:
- **`status`:** `live` (running, the URL works), `catalog` (installed but not running) or `down` (starting or dying).
- **`url`:** relative to `$OS_API_BASE`.
- **`description`:** what it offers.

You can read it two ways:
- **Over HTTP.** Every MCP server: `curl -s "$OS_API_BASE/api/interfaces?kind=mcp&consumers=0"`. Everything: drop `kind`. Filters are `kind`, `appId`, `name` and `live=1`. Leave out `consumers=0` to also get the dependency report (`live` / `installed` / `unmet`).
- **Over MCP.** `com.aura.settings` provides an MCP server for the registry itself at `$OS_API_BASE/api/proxy/com.aura.settings/mcp/interfaces`. Its tools are `list_interfaces`, `resolve_interface`, `get_interface` and `list_consumers`.

Humans browse the same registry in Settings → Interfaces.

**Connect an MCP server you found.** The full address is `$OS_API_BASE` + the entry's `url`. Check the tool list first; if a server isn't connected, offer to add it, e.g. the docs server:
- Claude Code: `claude mcp add --scope user --transport http aura-docs "$OS_API_BASE/api/proxy/com.aura.docs/mcp"`
- Codex: `codex mcp add aura-docs --url "$OS_API_BASE/api/proxy/com.aura.docs/mcp"`

Good first adds are the docs and the interface registry. Your own app can show up here too: add `provides[]` to its manifest (see the docs page "Interfaces").

## Working safely

- Explore with read-only commands (`get`, `describe`, `logs`, `status`).
- Confirm with the user before `rm`, `revoke`, `disable`, `kill` and `stop`. Stopping `com.aura.terminal` ends the session you are running in.
- Use `aura start|stop|restart` to control apps. Plain `docker restart` drops an instance from AuraOS.

## Your notes

AuraOS creates this file only if it is missing, so it is yours to edit. Add your own conventions below.
