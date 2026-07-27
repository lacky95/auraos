# {{APP_NAME}}

A **Pocket Builder** project. It is a normal AuraOS app (`{{APP_ID}}`) living in
the `user` scope, so it survives image rebuilds and is managed with the usual
tooling (`aura app start {{APP_ID}}`, Nexus, the Pocket Builder dashboard).

## Shape

```
app.manifest.json        services[] declares the PocketBase sibling container
src/lib/pocketbase.ts    SidecarHost wiring (ensure / teardown / status)
src/pages/index.astro    the frontend
src/pages/api/pb/…       reverse proxy → PocketBase (REST + admin UI)
src/pages/api/status.ts  live PocketBase state
```

## PocketBase

Runs as the sibling container `aura-<instanceId>--pocketbase` on `aura-net`,
started by the `onCreate` / `onStart` lifecycle hooks and removed on
`onDestroy`. Its data lives in the named volume `aura-{{APP_ID}}-pb-data`, so
it persists across restarts of the project.

Reach it from the frontend at the relative base `/api/pb`:

```js
const res = await fetch('/api/pb/api/collections/posts/records');
```

The admin UI is at `/api/pb/_/`.

## Git

Pocket Builder drives git for this project over the docker socket — it works
whether or not the project is running. Nothing here needs to be configured.
