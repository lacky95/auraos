# {{APP_NAME}}

A **Pocket Builder** project. It is a normal AuraOS app (`{{APP_ID}}`) living in
the `user` scope, so it survives image rebuilds and is managed with the usual
tooling (`aura run {{APP_ID}}`, Nexus, the Pocket Builder dashboard).

## Shape

```
app.manifest.json        services[] declares the PocketBase sibling container
src/lib/pocketbase.ts    sidecar wiring (ensure / teardown / status), OS-managed
src/pages/index.astro    the frontend
src/pages/api/pb/…       reverse proxy → PocketBase (REST + admin UI)
src/pages/api/status.ts  live PocketBase state
```

## PocketBase

Runs as the OS-managed sidecar `aura-<instanceId>--pocketbase` on `aura-net`:
the `onCreate` / `onStart` lifecycle hooks ask the OS to start it (the app has
no docker tool, just the `sidecars.spawn` permission), `onDestroy` removes it,
and the OS reaps it with the instance anyway. Its data lives in the app's data
dir under `.sidecars/pocketbase/pb-data`, so it persists across restarts of the
project.

`aura get inst {{APP_ID}} sidecars` lists it, `aura jump {{APP_ID}} --sidecar
pocketbase` opens a shell in it.

Reach it from the frontend at the relative base `/api/pb`:

```js
const res = await fetch('/api/pb/api/collections/posts/records');
```

The admin UI is at `/api/pb/_/`.

## Git

Pocket Builder drives git for this project over the docker socket — it works
whether or not the project is running. Nothing here needs to be configured.
