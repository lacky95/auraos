# builders/

Source for AuraOS **builders** — apps that create and manage other apps.

These live here rather than under `apps/` on purpose. `pnpm-workspace.yaml`
globs `apps/*`, and AppRegistry watches the system scope's apps dir, so
anything placed there is auto-registered as an immutable **system-scope** app.
Builders must be *installable* — one of several, added and updated over time —
and `NexusManager` refuses to install into the system scope precisely because
it is immutable. So the source is versioned here and deployed into a mutable
scope (`user` or `global`) instead.

```
builders/io.lakner.pocketbuilder/     git source — not auto-registered
        ↓  scaffold API / nexus publish
/data/scopes/users/default/apps/io.lakner.pocketbuilder     the running app
```

Because a builder is deployed outside the pnpm workspace, it follows the same
dependency convention as any user-scope app: `@aura/*` goes in
`auraDependencies` (not `dependencies`), and `aura sdk install` pulls it from
the local OCI registry at first boot — wired into the sandbox's synthesised
entrypoint.

> If the registry copy of an `@aura/*` package is behind the working tree, run
> `pnpm publish:local:fresh` from the repo root. It builds the libs and pushes
> them to the local Zot registry, which is what `aura sdk install` reads.

## Deploying a builder

The dashboard scaffolds its own projects through `POST /api/admin/scaffold`;
a builder itself is deployed the same way, with `scope: "user"` and
`force: true` to overwrite a previous version.

## Apps a builder creates

Projects are namespaced under the builder's own id — e.g.
`io.lakner.pocketbuilder.mynotes` — so an app's origin is readable from its id,
and the project list can be rebuilt from `GET /api/apps` alone if metadata is
lost.

## Current builders

| id | what it builds |
|---|---|
| `io.lakner.pocketbuilder` | PocketBase + web frontend apps, one container each |
