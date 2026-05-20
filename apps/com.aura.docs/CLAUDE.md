# Aura Docs — AuraOS app

> Identity: `com.aura.docs` · scaffolded by `aura dev new`.

This file primes Claude (or any AI assistant) for working on this app.
Read it once before changing code.

## What is AuraOS, in one screen

AuraOS is a browser-based WebOS that runs inside one Docker container.
There are two layers:

1. **The shell** (`packages/shell`, listens on `:3000`) — an Astro SSR app
   that draws the desktop: status bar, dock, launcher, layout manager, process
   manager. It owns the `AppManager` (lifecycle FSM, port allocator), the
   reverse proxy at `/api/proxy/<id>/<path>`, the content-provider router at
   `/api/data/<authority>/<path>`, and a global SSE event bus.

2. **The apps** (`apps/<reverse.domain.id>/`) — each is its **own Astro app**
   spawned in a **PRoot sandbox** with `/workspace`, `/data`, and an opt-in
   set of toolchain binaries bind-mounted in. Apps never talk to the browser
   directly; the shell proxies every request and injects HTML rewrites + a
   console-relay script into each iframe.

The shell loads each running instance in an iframe pointing at
`/api/proxy/<instanceId>/`. The proxy forwards to `http://localhost:<port>`
where the app's Astro dev server listens.

## What an "Aura app" is

It's an HTTP server with `app.manifest.json` + a small lifecycle contract.
Two runtime modes ship today:

- **`runtime: 'astro'` (default)** — the shell synthesises an `astro dev`
  command if no `entrypoint.sh` is present, and `auraAppIntegration()`
  injects identity headers + `/api/lifecycle/health`. The shell proxy
  rewrites HTML attributes, injects `<base href>`, meta tags, console
  relay, and key forwarder. Pick this for apps that *want* Astro/Vite —
  pretty much every reference app under `apps/` does.
- **`runtime: 'raw'`** — the OS spawns `manifest.entrypoint` directly. No
  Astro synth, no `<base href>`, no attribute rewriting. The app is
  responsible for binding to `$APP_PORT` and serving the lifecycle
  endpoints itself. Pick this for frameworks that already own their HTML
  + dev server (Next.js, SvelteKit, Nuxt, Remix, Astro-with-customised-
  config). This very app (`com.aura.docs`) is on `runtime: 'raw'` over
  Next.js — see "Raw runtime" below for the pattern.

Astro apps **don't need to ship `entrypoint.sh` or `health.ts`** —
`ProotRunner` synthesises the entrypoint, and `auraAppIntegration()`
(in `astro.config.mjs`) injects `/api/lifecycle/health`. Both can still be
overridden by shipping your own file if you really need to. Raw apps DO
need an explicit `entrypoint.sh` (no fallback) and must serve the lifecycle
endpoints from inside their own framework.

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

## Raw runtime (`runtime: 'raw'`)

Pick raw mode when your framework already owns HTML + has its own dev
server, or when you need WebSocket upgrades the Astro path's catch-all
can't proxy through. Three things change versus the default Astro path:

1. **You ship `entrypoint.sh`.** No synth fallback — the runner errors out
   if the file is missing. The script execs your framework on `$APP_PORT`:
   ```bash
   #!/bin/bash
   set -e
   cd /workspace/apps/com.example.foo
   [ ! -d node_modules ] && npm install
   exec npx next dev --hostname 0.0.0.0 --port "${APP_PORT:-4001}"
   ```
2. **You serve the lifecycle endpoints yourself** — same contract as
   Astro apps (POST `/api/lifecycle/{onCreate,onStart,onResume,onPause,
   onStop,onDestroy}` returning `{ ok: true }`, plus GET `/api/lifecycle/health`
   returning `{ ok, appId, instanceId }`). The `@aura/app-sdk/runtime/next`
   adapter packages this for Next.js as one catch-all route + a middleware:
   ```ts
   // app/api/lifecycle/[...hook]/route.ts
   import { createNextLifecycleRoutes } from '@aura/app-sdk/runtime/next';
   export const { POST } = createNextLifecycleRoutes({
     onDestroy: async () => { /* teardown */ },
   });
   ```
   ```ts
   // app/api/lifecycle/health/route.ts
   import { createNextHealthRoute } from '@aura/app-sdk/runtime/next';
   export const { GET } = createNextHealthRoute();
   ```
   ```ts
   // middleware.ts — stamp identity headers on every response
   import { NextResponse, type NextRequest } from 'next/server';
   import { auraIdentityHeaders } from '@aura/app-sdk/runtime/next';
   export function middleware(_req: NextRequest) {
     const res = NextResponse.next();
     for (const [k, v] of Object.entries(auraIdentityHeaders())) res.headers.set(k, v);
     return res;
   }
   export const config = { matcher: '/(.*)' };
   ```
   No Next adapter for your framework? Roll a 6-line equivalent: middleware
   that stamps `X-Aura-App-Id` / `X-Aura-Instance-Id` from `process.env`
   onto every response, plus a `GET /api/lifecycle/health` returning the
   identity body. Lifecycle hooks default to a no-op `{ ok: true }` JSON.

3. **The shell proxy switches its inject pipeline off by default.** Each
   inject (HTML attribute rewriting, `<base href>`, meta tags, console
   relay, key forwarder, identity script) is independently toggleable
   in the manifest's `proxy` block. Three presets to copy:

   ```jsonc
   // Pure pass-through (e.g. a Go web server you don't want to touch):
   "runtime": "raw",
   "proxy": { "rewriteHtml": "none", "injectMeta": false,
              "injectConsoleRelay": false, "injectKeyForwarder": false,
              "injectIdentityScript": false }

   // Next.js with basePath (this app's preset — keeps OS meta + relay,
   // forwards the proxy prefix to upstream so basePath matches without 308):
   "runtime": "raw",
   "proxy": { "rewriteHtml": "none", "preservePrefix": true,
              "injectMeta": true, "injectConsoleRelay": true,
              "injectKeyForwarder": true }

   // SvelteKit / Nuxt that emit absolute basePath-prefixed URLs but DON'T
   // want a <base href>: rewrite attributes but skip the base tag.
   "runtime": "raw",
   "proxy": { "rewriteHtml": "absolute", "preservePrefix": true,
              "injectMeta": true }
   ```

The `aura-app-id` + `aura-instance-id` meta tags are ALWAYS injected —
the shell's iframe identity guard reads them on load. Everything else
is gated by the flags above.

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
`runtime` (`'astro' | 'raw'` — see Raw runtime above), `proxy` (per-app
proxy inject toggles), `maxInstances`, `maxActivitiesPerInstance`,
`defaultLaunch`, `backgroundService`, `warmPool`, `viewConfig`, `preferredLayout`,
`themeStrategy`, `theme`, `keymapActions`, `dataProvider`, `serverPort`,
`icon`, `entrypoint`.

**Instance vs. Activity**:
- *Instance* = one running backend process (one Astro server, one PID, one port).
- *Activity* = one UI screen / iframe. Multiple activities can share an instance.
- Single-instance apps reuse the same backend; activity-mode apps get multiple
  views in the layout, each with its own `activityId` in the URL.

## Theming (`themeStrategy`)

AuraOS exposes its palette as CSS custom properties (`--aura-color-primary`,
`--aura-color-bg`, …) plus a `prefers-color-scheme`-aware light/dark axis.
Pick how this app participates by setting `themeStrategy` in the manifest:

| Strategy    | What the proxy injects                                    | When to use                                     |
|-------------|-----------------------------------------------------------|-------------------------------------------------|
| `inherit`   | `<link rel="stylesheet" href="/api/os/theme.css">` + meta | **Default.** Use `var(--aura-color-*)` and you're done. |
| `themed`    | `<meta name="aura-theme-id">`, `aura-color-mode`, framework | App ships its own palettes but reacts to OS theme/mode (via `osClient.onThemeChange()` / `onModeChange()`). |
| `override`  | Only `aura-color-mode` meta as a hint                     | App owns its palette completely — photo editors, brand-locked surfaces, accessibility tools. |

The Process Manager surfaces a `THEMED` / `OVERRIDE` chip on apps that don't
`inherit`, so users understand why an app looks different.

For most apps, leave it at `inherit` and just reference the CSS vars:

```css
body { background: var(--aura-color-bg); color: var(--aura-color-text); }
.primary { color: var(--aura-color-primary); }
```

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

On HTTP requests proxied through the shell, your handlers also receive:

| Request header        | Meaning                                                              |
|-----------------------|----------------------------------------------------------------------|
| `x-aura-app-id`       | Your app id                                                          |
| `x-aura-instance-id`  | The instance id                                                      |
| `x-aura-activity-id`  | The current activity id (only present for activity-mode apps)        |

Read them via `readIdentityHeaders(request)` from the SDK rather than
hand-rolling `request.headers.get(...)`.

## Common patterns

**Live updates to the iframe**: open an SSE endpoint inside your app
(`src/pages/api/events.ts`) and connect from the browser with
`new EventSource('api/events')` — relative URL, because the iframe's
`<base href>` is set by the proxy. The shell preserves stream lifetimes.

**WebSockets**: add an integration in `astro.config.mjs` that hooks
`astro:server:setup` and listens for `upgrade` events on `server.httpServer`.
The shell's Vite plugin proxies the upgrade through
`ws://<host>/api/proxy/<id>/<path>`. See `apps/com.aura.terminal` for a
working example (PTY over `/ws`) and `apps/com.aura.console` for a logging
WebSocket that persists to disk.

**Cross-app data**: declare a `dataProvider` in the manifest and serve
`/api/data/<...>` from your app. Other apps reach you via
`/api/data/<authority>/<your-path>` on the shell; permissions are checked
by the `PermissionManager`. Read provider data with `OsClient` from
`@aura/app-sdk` (`queryProvider`, `writeProvider`, `watchProvider`) or
plain `fetch`.

**Console + debugging**: every iframe's `console.*`, uncaught errors,
unhandled rejections, `fetch`/`XHR`/`EventSource` errors are auto-relayed
to the shell and forwarded to the Console app (and persisted to a JSONL
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

## CLI cheatsheet

```sh
# from inside the container or any shell with `aura` on PATH:
aura app start    com.example.foo
aura ps                                  # who's running
aura inst shell   com.example.foo[-N]    # drop into the PRoot
aura inst logs    com.example.foo[-N]    # tail logs
aura cap install  <name>                 # add a tool to /os/toolchain/bin/
aura cap grant    com.example.foo <cap>  # add to this manifest's tools[]
aura dev validate apps/com.example.foo   # schema-check the manifest
aura dev clean-manifest <path>           # strip default-valued fields
aura events       --filter "app:*"       # watch the event bus
aura whereami                            # what layer am I in (proot/ctnr/host)
```

The terminal apps' bash also annotates the prompt with the detected layer
(`root@<host>[proot+ctnr]:~$`) via a snippet in `/root/.bashrc`.

## Project conventions

- TypeScript strict, ES modules.
- Reverse-domain IDs (`com.example.foo`); the dir name must equal `manifest.id`.
- Don't import server-only Node modules into client-rendered Astro pages.
- HMR is disabled in app iframes (the upstream Vite WS isn't reachable from
  the browser through the proxy). Full iframe reload picks up changes.
- Apps cannot mutate state in `/os/` or the shell — only `/data` is writable
  per-instance. Use a content provider if you need to expose state to others.
- PRoot is a filesystem sandbox, not a security sandbox: it shares the host
  kernel and has no UTS / PID / user namespace. Treat apps as cooperating,
  not adversarial.

## Where things live in the parent repo

```
packages/core         AppManager, ProotRunner, OsEventBus, PermissionManager,
                      ContentProviderRegistry, ThemeManager, manifest schema
packages/shell        Astro SSR shell, /api/proxy, /api/data, /api/apps,
                      OSLayout (console bridge, theme), launcher, layout
packages/app-sdk      App-side SDK: OsClient, lifecycle factories, context,
                      auraAppIntegration
packages/aura-cli     The `aura` CLI you just used to scaffold this app
packages/ui           Shared UI primitives
apps/<id>             Each app, including this one
```

## Where to look when stuck

- Lifecycle FSM and allowed transitions: `packages/core/src/app-manager/LifecycleStateMachine.ts`
- How the shell builds your iframe URL: `packages/shell/src/pages/index.astro` (`buildView`)
- How HTML/JS get rewritten on the way to the iframe: `packages/shell/src/pages/api/proxy/[id]/[...path].ts`
- How the spawner constructs the PRoot args: `packages/core/src/app-manager/ProotRunner.ts` (`buildProotArgs`)
- The reference apps for richer patterns: `apps/com.aura.terminal` (WS+PTY),
  `apps/com.aura.notepad` (multi-activity shared state), `apps/com.aura.counter`
  (multi-instance + activities), `apps/com.aura.settings` (content provider + theme),
  `apps/com.aura.console` (WS persistence + static HTML page).
