# {{APP_NAME}} — AuraOS app

> Identity: `{{APP_ID}}` · scaffolded by `aura dev new`.

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

It's an Astro app with a `app.manifest.json`, an `entrypoint.sh` that
launches `astro dev` on `$APP_PORT`, and seven lifecycle HTTP endpoints
under `src/pages/api/lifecycle/`. The shell calls those endpoints over HTTP
when it spawns, pauses, resumes, or kills your instance.

### Required surface

| Path                                          | Purpose                                                                |
|-----------------------------------------------|------------------------------------------------------------------------|
| `app.manifest.json`                           | Identity, modes, tools, permissions, viewConfig, optional dataProvider |
| `entrypoint.sh`                               | Started by `ProotRunner`; must `exec` astro on `$APP_PORT`             |
| `src/pages/api/lifecycle/health.ts`           | `GET` returning 200 once ready — shell polls this to leave `creating`  |
| `src/pages/api/lifecycle/onCreate.ts`         | `POST` — first hook after spawn                                        |
| `src/pages/api/lifecycle/onStart.ts`          | `POST` — after `onCreate`                                              |
| `src/pages/api/lifecycle/onResume.ts`         | `POST` — every time the instance becomes the foreground                |
| `src/pages/api/lifecycle/onPause.ts`          | `POST` — when the user backgrounds the app                             |
| `src/pages/api/lifecycle/onStop.ts`           | `POST` — before destroy                                                |
| `src/pages/api/lifecycle/onDestroy.ts`        | `POST` — final shutdown hook                                           |
| `src/pages/api/lifecycle/onActivityCreate.ts` | (Optional) `POST` returning `{ path, title? }` for activity apps       |

Lifecycle hooks may be no-ops; the shell tolerates 404 on the optional ones.

## Key manifest fields

```jsonc
{
  "id": "com.example.foo",                       // reverse-domain; equals dir name
  "name": "Foo",
  "version": "0.1.0",
  "entrypoint": "entrypoint.sh",
  "tools": ["bash", "node", "git"],              // bind-mounted into PRoot from /os/toolchain/bin/
                                                 // also see `aura cap install <name>` for more
  "permissions": [],                             // free-form strings; PermissionManager auto-grants in MVP
  "instanceMode": "single",                      // single = at most one backend process; multi = N processes
  "maxInstances": 0,                             // hard cap for multi (0 = unlimited)
  "activityMode": "none",                        // none = 1 view = 1 instance; multi = N activities per instance
  "maxActivitiesPerInstance": 0,
  "defaultLaunch": "new-instance",               // only meaningful for multi/multi apps
  "backgroundService": false,                    // true = instance survives last activity close
  "viewConfig": { "defaultWidth": 600, "defaultHeight": 400, "resizable": true },
  "dataProvider": {                              // optional content-provider declaration
    "authority": "com.example.foo",
    "providers": [
      { "path": "/api/data/things", "readPermission": "foo.read", "writePermission": "foo.write" }
    ]
  }
}
```

**Instance vs. Activity**:
- *Instance* = one running backend process (one Astro server, one PID, one port).
- *Activity* = one UI screen / iframe. Multiple activities can share an instance.
- Single-instance apps reuse the same backend; activity-mode apps get multiple
  views in the layout, each with its own `activityId` in the URL.

## Runtime context the app sees

Inside the PRoot, your Astro process gets:

| Env var               | Meaning                                                              |
|-----------------------|----------------------------------------------------------------------|
| `APP_ID`              | Manifest `id`                                                        |
| `APP_INSTANCE_ID`     | `appId` (single) or `appId-N` (multi)                                |
| `APP_PORT`            | The port to bind your Astro server to                                |
| `OS_API_BASE`         | Shell URL — usually `http://localhost:3000`                          |

On HTTP requests proxied through the shell, your handlers also receive:

| Request header        | Meaning                                                              |
|-----------------------|----------------------------------------------------------------------|
| `x-aura-app-id`       | Your app id                                                          |
| `x-aura-instance-id`  | The instance id                                                      |
| `x-aura-activity-id`  | The current activity id (only present for activity-mode apps)        |

Read them in `.astro` frontmatter or API routes via `Astro.request.headers`.
**Note**: a static HTML page (`src/pages/*.html`) cannot read these headers
— if you need the ids client-side, read them from `?inst=` / `?activity=`
querystring instead, which the shell will append when constructing the
iframe `src`.

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
packages/app-sdk      Tiny browser SDK: OsClient (queryProvider, theme, …)
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
