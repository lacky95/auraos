# AuraOS — repo guide

pnpm monorepo. `packages/*` are the OS itself (shell, core, SDK, CLI, UI),
`apps/*` are the apps that run on it. The OS runs **inside a container** and
spawns each app as a sibling container or a PRoot process, so "the OS" and
"the thing you are editing" are the same working tree.

App-authoring docs live in `packages/aura-cli/src/templates/app/CLAUDE.md` —
the file `aura dev new` copies into every scaffolded app. Edit it there;
`apps/com.aura.{browser,docs,example}/CLAUDE.md` are copies of it.

## Running it

```sh
make up          # build aura-base + compose up (service aura-os → container aura-shell)
make restart     # restart the shell container
make logs        # follow shell logs (app logs are prefixed [<appId>])
make ps          # running aura-* containers
```

The shell serves `http://localhost:3000`. Each app is its own Astro dev server
on a port in 4001–4999, reached through `/api/proxy/<appId>/<path>`.

Compose project name is **not** always the directory name — `docker-compose.override.yml`
pins the volume names for it. Prefer `docker restart aura-shell` /
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

## Verifying UI changes

Playwright is installed at the repo root with browsers cached, so a script can
drive the real UI:

- Run the script **from `/workspace`** or `playwright` won't resolve.
- Load app pages through the proxy (`http://localhost:3000/api/proxy/<appId>/<page>`).
- To reproduce iframe conditions, serve a **same-origin** wrapper — embedding
  the proxy URL in an iframe from another origin returns 403. Intercept a URL
  on `localhost:3000` with `page.route(...)` and fulfil it with the iframe HTML.
- Assert styling with `getComputedStyle`, not by eye. A control that got no
  rule at all still renders as a normal-looking UA widget.

Type checks and unit tests:

```sh
pnpm typecheck                        # recursive
pnpm --filter @aura/core test         # + @aura/kv-store test
```

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
outside the consumer's scan roots (e.g. `@aura/ui` components) are dropped
from the build unless that path is declared with `@source` — see
`packages/ui/src/styles/scificn-bridge.css`, which also explains why the glob
has to include `js`.

**4. Theme tokens are a closed set.** `/api/os/theme.css` defines exactly
`--aura-color-{primary,secondary,danger,info,warning,success,bg,surface,surface-2,text,text-dim,border}`
and `--aura-glow-{primary,secondary,danger,subtle}`. Any other name is not an
error — `var(--aura-color-bg-elev, #111)` silently uses the literal, so an
invented token looks correct under dark themes and renders black under light
ones. Don't give these vars literal fallbacks either: if the token exists the
fallback is dead code, and if it doesn't you want to see that. For a filled
control, `background: var(--aura-color-primary); color: var(--aura-color-bg)`
keeps the label legible in both modes.

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
packages/kv-store     Redis-backed KV + namespace validation
packages/aura-cli     the `aura` CLI, and the app template it scaffolds from
packages/ui           shared UI primitives (React/scificn) + theme bridge
apps/<id>             apps shipped with the OS
os/                   entrypoint shims, bashrc, publish scripts
```

Start points when stuck: `packages/shell/src/middleware.ts` (what boots on
first request), `packages/core/src/app-manager/` (how apps are spawned),
`packages/shell/src/pages/api/proxy/[id]/[...path].ts` (how app HTML/JS is
rewritten for the iframe).
