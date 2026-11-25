# {{APP_NAME}} — AuraOS app

> Identity: `{{APP_ID}}` · scaffolded by `aura dev new`.

This file primes any coding agent (Codex reads it directly; Claude Code
reads it through the one-line `CLAUDE.md`). Read it once before changing code.

## Build and test

```sh
pnpm install          # once (user/global apps: `aura sdk install` adds @aura/*)
pnpm dev              # astro dev on $APP_PORT (default 4001)
pnpm build            # production build -> dist/
aura dev validate .   # manifest schema + App Host contract checks
aura run {{APP_ID}}   # start it in AuraOS (prints the instance id)
```

Add your own test command as `scripts.test` in `package.json` and list it
here, so whoever patches an installed copy can run it in the workspace.

## Source changes

There are two kinds of source, and the rule differs:

- **This repository (the author's checkout)** is always writable. Commit
  here as usual. `aura dev publish --repo <url>` sets `origin`, pushes the
  history (main and tags), records `repository` in the manifest and publishes
  a release.
- **An installed copy** follows `source.defaultMode` in `app.manifest.json`
  (`closed` unless you change it; the owner can override it per install).
  A closed install's source is read-only: never write into it, never copy
  it elsewhere to run it, and never use Docker or another app's mount to get
  around the read-only rule. Change it as a patch instead:

  ```sh
  aura dev status {{APP_ID}}            # source path (read-only), mode, base, patches, next step
  aura dev patch start {{APP_ID}}       # writable workspace at /mnt/aura/work/<app>
  # edit and test in the workspace, then:
  aura dev patch save -m "What changed"  # versioned patches/NNNN-*.patch in the patch repo
  aura dev patch activate               # build + install it (the owner approves)
  aura dev patch list                   # the series, the active revision
  ```

  Upstream updates keep the patches: `aura dev update {{APP_ID}}` applies the
  series to the new upstream. If a patch no longer applies, it is named, the
  installed app keeps running, and you repair it with
  `aura dev patch start {{APP_ID}} --base <new commit>`, fix, save, activate.
- **Open installs** (the owner ran `aura dev open {{APP_ID}}`) are a writable
  developer checkout; `aura dev status` prints its path.

If a write fails with "Read-only file system", that is the rule above, not a
bug: run `aura dev status {{APP_ID}}` and follow the next step it prints.

## What is AuraOS, in one screen

AuraOS is a browser-based WebOS that runs inside one Docker container.
There are two layers:

1. **The shell** (`packages/shell`, listens on `:3000`) — an Astro SSR app
   that draws the desktop: status bar, dock, launcher, layout manager, process
   manager. It owns the `AppManager` (lifecycle FSM, port allocator), the
   App Host router, the content-provider router at
   `/api/data/<authority>/<path>`, and a global SSE event bus.

2. **The apps** (`apps/<reverse.domain.id>/`) — each is its **own Astro app**
   spawned in a **PRoot sandbox** with `/workspace`, `/data`, and an opt-in
   set of toolchain binaries bind-mounted in.

## Where your window lives: the App Host

Each app window is an iframe on an **App Host**: an origin of its own,
`<label>--<desktop host>` (e.g. `http://notesabcd1234--10-0-0-2.nip.io:3000`).
The shell forwards it, requests and WebSockets alike, to the port your
server listens on. Your app is **served from `/`, with nothing rewritten and
nothing injected into your HTML**. So:

- **No base path.** Root-absolute URLs (`/assets/app.js`, `/api/save`,
  `/ws`) reach your own server. There is no `<base href>` and no
  `getAppBasePath()`.
- **`/api/…` on your origin is yours.** The shell is at `/_aura/os/`: reach
  it through `OsClient` or `osUrl('/api/…')` from `@aura/app-sdk`, never with
  a bare `/api/…` from the browser.
- **Identity and theme come from `window.AuraRuntimeBootstrap`**, which
  `/_aura/runtime.js` sets (`auraAppIntegration()` loads it on every page).
  Read it with `appHostRuntime()` (`appId`, `instanceId`, `activityId`,
  `theme.resolvedMode`). There are no `aura-*` `<meta>` tags and no
  `AURA_APP_ID` / `AURA_INSTANCE_ID` / `AURA_APP_BASE_PATH` globals.
- **Talk to the shell** with `postToShell()` / `isFromShell()`, never
  `window.parent.postMessage(…, '*')`.
- **`/api/proxy/<appId>/…` is for machines only** (agents, other apps'
  servers): browser pages and frames get a 403 there.
- **Browser storage is per App Host** and starts empty; keep anything that
  matters on the server.

The full contract is the Aura Docs page **"Building an app for App Hosts"**
(`apps/com.aura.docs/fumadocs-site/content/docs/building-for-app-hosts.mdx`).
`aura dev validate .` checks this app against it (removed SDK imports,
`aura-*` meta reads, `/api/proxy` URLs in pages, stale manifest keys).

## What an "Aura app" is

It's an Astro app with `app.manifest.json` and lifecycle HTTP endpoints under
`src/pages/api/lifecycle/`. The shell calls those endpoints over HTTP when
it spawns, pauses, resumes, or kills your instance.

You **don't need to ship `entrypoint.sh` or `health.ts`** — `ProotRunner`
synthesises the entrypoint, and `auraAppIntegration()` (in `astro.config.mjs`)
injects `/api/lifecycle/health`. Both can still be overridden by shipping
your own file if you really need to.

### Required surface

| Path                                          | Purpose                                                                |
|-----------------------------------------------|------------------------------------------------------------------------|
| `app.manifest.json`                           | Identity, modes, tools, permissions, viewConfig, optional dataProvider |
| `astro.config.mjs`                            | Must include `auraAppIntegration()`                                    |
| `src/pages/api/lifecycle/onCreate.ts`         | `POST` — first hook after spawn                                        |
| `src/pages/api/lifecycle/onStart.ts`          | `POST` — after `onCreate`                                              |
| `src/pages/api/lifecycle/onResume.ts`         | `POST` — every time the instance becomes the foreground                |
| `src/pages/api/lifecycle/onPause.ts`          | `POST` — when the user backgrounds the app                             |
| `src/pages/api/lifecycle/onStop.ts`           | `POST` — before destroy                                                |
| `src/pages/api/lifecycle/onDestroy.ts`        | `POST` — final shutdown hook                                           |
| `src/pages/api/lifecycle/onActivityCreate.ts` | (Optional) `POST` returning `{ path, title? }` for activity apps       |

The scaffold ships every required hook as a one-liner that uses
`createLifecycleHandler()` from `@aura/app-sdk`. Add your own behaviour by
passing an `impl`:

```ts
// src/pages/api/lifecycle/onDestroy.ts
import { createLifecycleHandler } from '@aura/app-sdk';
import { state } from '../../../state.js';
export const POST = createLifecycleHandler('onDestroy', async () => {
  state.activities.clear();
  await flushPendingWrites();
});
```

For activity-mode apps, use the typed activity factories:

```ts
// src/pages/api/lifecycle/onActivityCreate.ts
import { createActivityCreateHandler } from '@aura/app-sdk';
import { state } from '../../../state.js';
export const POST = createActivityCreateHandler(({ activityId }) => {
  state.activities.add(activityId);
  return { path: '/', title: `My App ${activityId.split('#').pop()}` };
});
```

```ts
// src/pages/api/lifecycle/onActivityDestroy/[activityId].ts
import { createActivityDestroyHandler } from '@aura/app-sdk';
import { state } from '../../../../state.js';
export const POST = createActivityDestroyHandler((activityId) => {
  state.activities.delete(activityId);
});
```

## Manifest fields

The scaffold writes only the fields you actually need to pick — every other
manifest field has a sensible schema default. Run `aura dev clean-manifest`
to strip any default-valued fields you've written by hand.

```jsonc
{
  "id": "com.example.foo",         // reverse-domain; equals dir name
  "name": "Foo",
  "version": "0.1.0",
  "description": "...",
  "category": "utility",            // also: productivity, media, communication, system, game, developer
  "permissions": [],                // see Permission strings below
  "tools": ["bash", "node"],        // bind-mounted from /os/toolchain/bin/
  "instanceMode": "single",         // 'single' | 'multi'
  "activityMode": "none"            // 'none' | 'multi'
}
```

Optional fields (all have defaults — only set them if you need a non-default):
`maxInstances`, `maxActivitiesPerInstance`, `defaultLaunch`,
`backgroundService`, `warmPool`, `viewConfig`, `preferredLayout`,
`themeStrategy`, `theme`, `keymapActions`, `dataProvider`, `serverPort`,
`icon`, `entrypoint`.

`repository: { url, branch?, commit? }` says where the app is developed.
Published bundles never ship `.git`; publish fills in `branch` + `commit` in
the released manifest (keep `"commit": ""` in your repo), and anyone who
installs the app can run `aura dev checkout <id>` to turn their copy into a
git checkout at exactly that commit.

`source: { defaultMode: "closed" | "open" }` is what an installed copy
starts as (default `closed`: read-only, changed only through patches; see
"Source changes"). The owner's choice per install wins over it.

**Instance vs. Activity**:
- *Instance* = one running backend process (one Astro server, one PID, one port).
- *Activity* = one UI screen / iframe. Multiple activities can share an instance.
- Single-instance apps reuse the same backend; activity-mode apps get multiple
  views in the layout, each with its own `activityId` in the URL.

## Theming (`themeStrategy`)

AuraOS exposes its palette as CSS custom properties (`--aura-color-primary`,
`--aura-color-bg`, …) plus a `prefers-color-scheme`-aware light/dark axis.
Pick how this app participates by setting `themeStrategy` in the manifest:

Every page gets the theme in `AuraRuntimeBootstrap.theme` (read it with
`appHostRuntime()?.theme`); what else `/_aura/runtime.js` does depends on the
strategy:

| Strategy    | What `/_aura/runtime.js` adds                                         | When to use                                     |
|-------------|-----------------------------------------------------------------------|-------------------------------------------------|
| `inherit`   | Links the OS theme (`/_aura/os/api/os/theme.css`), refreshed on every change | **Default.** Use `var(--aura-color-*)` and you're done. |
| `themed`    | Nothing beyond the bootstrap                                          | App ships its own palettes but reacts to OS theme/mode (via `osClient.onThemeChange()` / `onModeChange()`). |
| `override`  | Nothing beyond the bootstrap                                          | App owns its palette completely — photo editors, brand-locked surfaces, accessibility tools. Use `theme.resolvedMode` for light/dark. |

The Process Manager surfaces a `THEMED` / `OVERRIDE` chip on apps that don't
`inherit`, so users understand why an app looks different.

For most apps, leave it at `inherit` and just reference the CSS vars:

```css
body { background: var(--aura-color-bg); color: var(--aura-color-text); }
.primary { color: var(--aura-color-primary); }
```

## Icons — Lucide is the OS default

Do NOT bundle your own icon library. The shell serves Lucide (~2000 icons,
https://lucide.dev/icons) OS-wide, themed via `currentColor`:

- **Sprite (curated ~100 common icons)** — zero dependencies, works in plain
  HTML/Astro/React alike:

  ```html
  <svg class="aura-icon"><use href="/_aura/os/api/os/icons.svg#lucide-settings"/></svg>
  ```

  The shell's files are under `/_aura/os/` on your App Host (`osUrl()` from
  the SDK builds these addresses; in an Astro app `auraAppIntegration()` also
  redirects `/api/os/icons.svg` and `/api/os/theme.css` there). `.aura-icon` (shipped in the OS theme.css) sizes the icon to `1em`
  and aligns it with text; the stroke follows the element's `color`, so it
  recolors with the theme automatically. Override size with your own
  width/height. Unknown symbol ids render nothing — check the sprite
  (`curl "$OS_API_BASE/api/os/icons.svg"`) if an icon does not appear.

- **Single icon (any Lucide name)** — `/_aura/os/api/os/icons/<name>.svg`
  (`osUrl('/api/os/icons/<name>.svg')`; 404 on
  unknown names). Fine for `<img>` or CSS `mask-image`; note a standalone
  SVG document cannot see the page's `color`, so prefer the sprite when the
  icon must follow the theme.

- **React + @aura/ui** — `import { Icon } from "@aura/ui"` then
  `<Icon name="rotate-cw" />` (kebab-case Lucide names, `currentColor`,
  defaults to `1em`).

## Styling rules that stop silent misses

CSS that doesn't apply never errors — the element just falls back to the
browser's default chrome, which still *looks* like a deliberate design. Four
rules keep that from happening:

**1. Style by class, select by `data-*`.** A class on an element must exist
because it carries styling. When JS needs to find an element, give it a data
attribute, not a second class — a JS-only class has no rule behind it, and the
day someone reuses it for a new control it renders unstyled.

```html
<!-- WRONG: .row-del-vol is a JS hook with no rule; it renders as a UA button -->
<button class="row-del-vol" data-name="shared">DELETE</button>

<!-- RIGHT: one styled class, the hook lives in the data attribute -->
<button class="row-del" data-vol="shared">DELETE</button>
```

```js
tbody.addEventListener('click', (e) => {          // delegate, don't rebind
  const btn = e.target.closest('.row-del[data-vol]');
  if (btn) removeVolume(btn.dataset.vol);
});
```

Delegation matters for the same reason: re-rendering rows drops per-button
listeners, and rebinding after a partial update stacks a second listener on
the rows that survived.

**2. Rows built with `innerHTML` need `<style is:global>`.** Astro scopes a
plain `<style>` by stamping `data-astro-cid-*` on the markup it renders. HTML
you inject at runtime never gets that attribute, so scoped rules stop matching
the moment a row is re-rendered. Either render those elements with `is:global`
styles (say why in a comment) or keep the whole list server-rendered.

**3. Tailwind only sees files it scans.** Utilities used inside a package
outside your app's scan roots (e.g. `@aura/ui` components) are dropped from
the build unless that path is declared with `@source`. When a utility class
does nothing, check the scan roots before debugging the markup.

**4. Theme tokens are a closed set.** `/api/os/theme.css` defines exactly
`--aura-color-{primary,secondary,danger,info,warning,success,bg,surface,surface-2,text,text-dim,border}`
and `--aura-glow-{primary,secondary,danger,subtle}`. Any other name is not an
error — `var(--aura-color-bg-elev, #111)` silently uses the literal, so an
invented token looks correct under dark themes and renders black under light
ones. Don't give these vars literal fallbacks either: if the token exists the
fallback is dead code, and if it doesn't you want to see that. For a filled
control, `background: var(--aura-color-primary); color: var(--aura-color-bg)`
keeps the label legible in both modes.

When something looks unstyled, confirm it with computed style rather than by
eye — `getComputedStyle(el).borderTopStyle === 'outset'` is the tell for a
button that got no rule at all.

## Runtime context the app sees

Inside the PRoot, your Astro process gets:

| Env var               | Meaning                                                              |
|-----------------------|----------------------------------------------------------------------|
| `APP_ID`              | Manifest `id`                                                        |
| `APP_INSTANCE_ID`     | `appId` (single) or `appId-N` (multi)                                |
| `APP_PORT`            | The port to bind your Astro server to                                |
| `OS_API_BASE`         | Shell URL — usually `http://localhost:3000`                          |
| `AURA_LAYER_TAG`      | "[proot+ctnr]" — for prompts / diagnostics                           |

Don't reach for `process.env` directly — use the SDK's `getAppContext()`:

```ts
import { getAppContext } from '@aura/app-sdk';
const ctx = getAppContext();
// → { appId, instanceId, appPort, osApiBase, dataDir, layerTag }
```

On HTTP requests the shell forwards to you, your handlers also receive:

| Request header        | Meaning                                                              |
|-----------------------|----------------------------------------------------------------------|
| `x-aura-app-id`       | Your app id                                                          |
| `x-aura-instance-id`  | The instance id                                                      |
| `x-aura-activity-id`  | The current activity id (only present for activity-mode apps)        |

Read them via `readIdentityHeaders(request)` from the SDK rather than
hand-rolling `request.headers.get(...)`.

## The app contract (`auraContract: 1`)

The manifest says which contract the app follows (`"auraContract": 1`) and
declares everything it uses: `permissions[]`, the Context keys it reads
(`context[]`), its sidecars (`services[]`), `"docker"` in `tools[]` if it
drives docker, and other apps' interfaces (`consumes[]`). App data goes in
`getAppContext().dataDir` (`/data`), never in `~` or the app folder. Read
Context on the server with `osClient.context.get('KEY')`, not from
`/run/context`. `aura dev validate <dir>` checks all of it; the Aura Docs page
"The Aura app contract" (`app-contract`) has the checklist.

## Common patterns

**Live updates to the iframe**: open an SSE endpoint inside your app
(`src/pages/api/events.ts`) and connect from the browser with
`new EventSource('/api/events')`: your app is served from `/` on its App
Host, so root-absolute URLs reach your own server. The runtime multiplexes
same-origin streams over one socket, so many streams don't exhaust the
browser's connection limit.

**WebSockets**: add an integration in `astro.config.mjs` that hooks
`astro:server:setup` and listens for `upgrade` events on `server.httpServer`.
The page connects to its own origin and the App Host forwards the upgrade
to your server. **Check the path and return early for anything else**, so
other sockets on the same server (such as Vite's `vite-hmr`) are left alone:

```js
// page
const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

// astro.config.mjs, in astro:server:setup
server.httpServer?.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') return;
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
```

See `apps/com.aura.terminal` for a working example (PTY over `/ws`) and
`apps/com.aura.console` for a logging WebSocket that persists to disk.

**Cross-app data**: declare a `dataProvider` in the manifest and serve
`/api/data/<...>` from your app. Other apps reach you via
`/api/data/<authority>/<your-path>` on the shell; permissions are checked
by the `PermissionManager`. Read provider data with `OsClient` from
`@aura/app-sdk` (`queryProvider`, `writeProvider`, `watchProvider`) or
plain `fetch`.

**Console + debugging**: every page's `console.*`, uncaught errors,
unhandled rejections, `fetch`/`XHR`/`EventSource` errors are relayed by
`/_aura/runtime.js` to the shell and forwarded to the Console app (and persisted to a JSONL
file via WebSocket → `apps/com.aura.console`). No setup needed.

**Keyboard shortcuts + OS Back + system actions**: all flow through the
single `@aura/app-sdk` framework. Declare actions in the manifest, register
handlers via `osClient.keymap.on(...)`, intercept Back via
`osClient.nav.onBack(...)`, trigger OS actions via `osClient.system.*`.
Apps that integrate nothing keep every native browser keyboard behavior
(text inputs, IME, Tab focus, Ctrl+A/C/Z, etc.) — the OS only intercepts
combos that are explicitly claimed.

```jsonc
// app.manifest.json
{
  "keymapActions": [
    { "id": "save", "label": "Save",  "category": "File", "defaultCombo": "Ctrl+s" },
    { "id": "find", "label": "Find",  "category": "Edit", "defaultCombo": "Ctrl+f" }
  ]
}
```

```ts
// in your page or React island
import { OsClient } from '@aura/app-sdk';
const osClient = new OsClient();

osClient.keymap.on('save', () => saveDocument());
osClient.keymap.on('find', () => openFindDialog());

osClient.nav.onBack((e) => {
  if (unsavedChanges()) { e.preventDefault(); confirmDiscard(); }
});

// Read the user's current mapping for menu shortcut hints — refreshed live.
const saveCombo = osClient.keymap.getBinding('save');  // "Ctrl+KeyS" or null

osClient.system.openLauncher();          // programmatic OS actions
osClient.system.switchWorkspace(2);
```

Combos accept friendly shorthand (`Ctrl+s` ⇄ `Ctrl+KeyS`). The user can
remap any action in **Settings → Keyboard**; your handler keeps firing
under the new combo without code changes. Action ids are namespaced
`app.<appId>.<short>` automatically — pass either the short id (`save`) or
the fully qualified id; the SDK handles both.

**Sidecars (a database, an agent, any foreign image)**: don't add `docker`
to `tools[]`. Use `"sandbox": "container"`, declare the image as a template
in `services[]`, add the `sidecars.spawn` permission, and let the OS start it:

```ts
import { osSidecars } from '@aura/app-sdk/os-sidecars';   // server-side only
const sc = osSidecars();
const { sidecar } = await sc.spawn({ template: 'db', wait: { port: true } });
// reach it at http://${sidecar.host}:<port>; sc.exec / sc.logs / sc.remove
```

Same name + same spec is adopted, a changed spec recreated — calling `spawn`
on every start is fine. Mounts of its own: `sidecars.mounts` + `apps.mount`,
spawn with `mounts: { own: true }`, then `sc.mounts(name).add(appId)`.

## CLI cheatsheet

```sh
# from inside the container or any shell with `aura` on PATH
# Basics
aura ps                                       # running instances (= aura get inst)
aura run      com.example.foo                 # start it (prints the instance id)
aura jump     com.example.foo                 # shell into its sandbox (no target: picker)
aura jump     com.example.foo --sidecar <id>  # shell into one of its sidecars
aura info                                     # where am I: layers, OS, env, mounts
# Inspect
aura get apps -o wide                         # any resource: -o wide|json|yaml|name
aura describe app com.example.foo             # full YAML of one resource
aura get inst com.example.foo sidecars        # its sidecars + their IDs
aura logs inst com.example.foo -c <id> -f     # a sidecar's logs
aura events -f 'app:*'                        # live OS state changes
# Lifecycle
aura restart app com.example.foo              # all instances -> one fresh
aura stop inst   <instanceId>                 # one instance
# Connect
aura exec inst com.example.foo -- ls          # one-off command in the sandbox
aura exec inst com.example.foo -c <id> -- sh  # ... or in a sidecar
aura mount add <otherAppId>                   # mount another app's files (read-only)
aura port expose com.example.foo:5173 --into <appId>   # share a TCP port
# Access
aura install cap <name>                       # add a tool to /os/toolchain/bin/
aura grant cap   com.example.foo <cap>        # add to this manifest's tools[]
aura grant perm  com.example.foo <perm>       # add a manifest permission
# Dev
aura dev validate apps/com.example.foo        # schema + App Host contract checks
aura dev clean-manifest <path>                # strip default-valued fields
aura dev checkout com.example.foo             # installed app → git checkout of its `repository`
aura dev status  com.example.foo             # where its source is, mode, patches, next step
aura dev patch start|save|list|activate      # change an installed app as a patch series
aura dev update  com.example.foo             # new upstream + your patches
aura dev publish --repo <url>                # push this repo's history + publish a release
aura --help                                   # every command, by task
```

The terminal apps' bash also annotates the prompt with the detected layer
(`root@<host>[proot+ctnr]:~$`) via a snippet in `/root/.bashrc`.

## Project conventions

- TypeScript strict, ES modules.
- Reverse-domain IDs (`com.example.foo`); the dir name must equal `manifest.id`.
- Don't import server-only Node modules into client-rendered Astro pages.
- HMR is off in the scaffold (`hmr: false` in `astro.config.mjs`): a page
  reload picks up changes. The App Host does forward WebSocket upgrades on
  any app path, so Vite HMR may work with it on, but that is not verified;
  if you turn it on, keep your own `upgrade` handlers path-checked.
- Class names are for styling, `data-*` attributes are for JS hooks — see
  "Styling rules that stop silent misses".
- After a write, render the row from the response you already have; treat the
  follow-up list GET as reconciliation, and never swallow its failure with a
  bare `if (!res.ok) return`.
- Never let the UI wait on a write forever. Inside an app iframe a write's
  response can fail to reach the page while reads keep working (confirmed in
  Chromium behind a local tunnel: the POST lands on the server in ms, reads
  answer in ms, the page never receives the write's response headers). So:
  change the page *before* the request (pending status, optimistic row,
  control disabled); race the fetch against a plain `setTimeout` deadline —
  `AbortSignal.timeout` alone did not fire there; and while the write is in
  flight, re-read the list every ~2 s and confirm the row from the list as
  soon as the server shows it. `apps/com.aura.settings/src/pages/context.astro`
  (`writeJson`, `pollUntil`) is the reference implementation.
- Apps cannot mutate state in `/os/` or the shell — only `/data` is writable
  per-instance. Use a content provider if you need to expose state to others.
- PRoot is a filesystem sandbox, not a security sandbox: it shares the host
  kernel and has no UTS / PID / user namespace. Treat apps as cooperating,
  not adversarial.

## Where things live in the parent repo

```
packages/core         AppManager, ProotRunner, OsEventBus, PermissionManager,
                      ContentProviderRegistry, ThemeManager, manifest schema
packages/shell        Astro SSR shell, App Hosts, /api/data, /api/apps,
                      OSLayout (console bridge, theme), launcher, layout
packages/app-sdk      App-side SDK: OsClient, lifecycle factories, context,
                      auraAppIntegration
packages/aura-cli     The `aura` CLI you just used to scaffold this app
packages/ui           Shared UI primitives
apps/<id>             Each app, including this one
```

## Where to look when stuck

- Lifecycle FSM and allowed transitions: `packages/core/src/app-manager/LifecycleStateMachine.ts`
- The App Host contract (what a page can and can't do): Aura Docs, "Building an app for App Hosts"
- How an App Host request reaches your server: `packages/shell/server/app-hosts.mjs`
- The `/_aura/os/` gateway and `/_aura/runtime.js`: `packages/shell/server/app-gateway.mjs`, `packages/shell/src/lib/appRuntime.ts`
- The machine proxy for agents (`/api/proxy/<id>/…`, no browser pages): `packages/shell/src/pages/api/proxy/[id]/[...path].ts`
- How the spawner constructs the PRoot args: `packages/core/src/app-manager/ProotRunner.ts` (`buildProotArgs`)
- The reference apps for richer patterns: `apps/com.aura.terminal` (WS+PTY),
  `apps/com.aura.notepad` (multi-activity shared state), `apps/com.aura.counter`
  (multi-instance + activities), `apps/com.aura.settings` (content provider + theme),
  `apps/com.aura.console` (WS persistence + static HTML page).
