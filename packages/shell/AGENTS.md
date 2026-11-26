# @aura/shell: the server layer and the Web Shell

The principles are in the root `AGENTS.md`. This package holds two layers outside the kernel. `pnpm arch` computes which layer a file is in from what it imports.

| Layer | Files | Role |
|---|---|---|
| **Server** | `src/pages/api/**` (166 routes), `src/middleware.ts`, `server/*.mjs` (App Host gateway, WS proxy, socket.io `/os-events`, SSE mux), `server.mjs`, `astro.config.mjs`, and the `src/lib/**` files they reach | transport, plus enforcement at the edge. It calls the kernel; it doesn't own kernel state |
| **Web Shell** | `src/pages/*.astro` (desktop pages), `src/components/**`, `src/layouts/**`, `src/stores/**`, and the `src/lib/**` files only they reach | presentation; one client among several |

## Rules (enforced: `server-webshell`, `package-internals`)

- **The server layer never imports Web Shell code** (components, layouts, stores, desktop pages) or UI libraries (React, `@aura/ui`, nanostores, `socket.io-client`).
  - The one baselined exception: `astro.config.mjs` always loads `@astrojs/react`. Phase 6 W fixes it with `AURA_COMPOSITION=server`.
- **Use core only through `@aura/core` and its declared subpaths.** Never a relative path into `packages/core`, `src/` or `dist/`.
- **Kernel decisions belong in core.** A route translates HTTP into a kernel call and back. It doesn't:
  - persist kernel state with `defaultKv()`;
  - emit kernel events (`app:*`, `activity:*`) itself;
  - hold lifecycle logic.

  **Existing debt, don't extend it:**
  - `api/admin/apps/enabled.ts` and `api/apps/[id]/remove.ts` write `os:app-enabled` (Phase 6 K);
  - `api/os/lock.ts` and `unlock.ts` write `os:lockscreen` and emit `kv:changed`;
  - `lib/appRestart.ts` emits `app:restart*`;
  - `lib/desktopSession.ts` respawns PRoot instances (5b RS).
- **Until Phase 6, `middleware.ts` is the kernel's init owner.** Phase 6 K moves init into core `bootSystem()`, and the middleware then waits for readiness. Don't add init steps here; register server-layer hooks instead (Phase 6, `lib/bootHooks.ts`).
- **No new `globalThis` or `Symbol.for()` state.** There are already about 35 files with it.
- **The access policy for every `/api` route** lives in `src/lib/access` (see its `AGENTS.md`). A new route needs a manifest row, or it is denied.

## Tests

- `node tools/run-tests.mjs --only=shell` (`test/*.test.ts` under tsx);
- `astro check`;
- browser and VM checks in the auraos-e2e repo.

## Styling rules that stop silent misses (Web Shell and app UIs)

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
