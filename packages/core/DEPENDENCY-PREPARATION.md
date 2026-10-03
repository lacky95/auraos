# Dependency preparation

Managed Astro apps prepare dependencies during clone/store installation and before a fresh instance is spawned. `aura app prepare <id>` performs the same work without starting a server. `--json` returns one structured result and exits nonzero on failure.

Preparation runs in the selected Docker image, PRoot rootfs, or direct runtime. It validates installed packages and native build tools locally, installs only when necessary, and verifies again before recording readiness. It never loads app configuration or calls app lifecycle hooks. A verified dependency tree is not a guarantee that application code will start successfully.

`aura clone` still excludes dependencies and build output. It now waits for preparation before claiming success. On failure the copied app remains installed, with an explicit preparation error and retry command. Raw apps remain externally managed; system/workspace apps are validated without changing workspace dependencies. Unsupported app lockfile formats fail explicitly.

Preparation records and bounded diagnostic logs live under `<dataDir>/aura/preparation/<hash-of-canonical-app-path>/`. The app API and Settings show preparation status independently of the instance lifecycle. Startup logs live under `<dataDir>/aura/startup/` and survive container removal.

## Installation and recovery

Npm installations include optional and development dependencies. A compatible existing npm lockfile uses `npm ci`; an app without a lockfile uses `npm install`. OCI SDK packages are installed afterward. Their runtime npm dependencies are installed in nested trees with retained locks, and their OCI/workspace dependencies are resolved from the published workspace versions. Peers resolve from the app, avoiding duplicate React installations.

A repair backs up `node_modules` and the lockfile. If the clean install still lacks a native package, Aura may add missing native lockfile entries at exact versions required by existing parent packages. It does not upgrade existing packages or delete the lockfile to re-resolve ranges. A failed or interrupted repair restores the previous artifacts. Timestamped lockfile backups remain available beside the preparation log.

Preparation is serialized with launch registration for each scoped app directory. If repair is needed while an instance is running, stop that app and retry. Requests have a 15-minute preparation ceiling; server health checking has a separate boot deadline and fails promptly on process exit.

## Verification

From the repository root:

```sh
npm --prefix packages/core test
npm --prefix packages/aura-cli run test:preparation
npm --prefix packages/aura-cli run typecheck
npm --prefix packages/shell run typecheck
```

The optional runtime smoke script copies the supplied app outside watched scopes and preserves the fixture/logs for inspection:

```sh
cd packages/core
AURA_PREPARATION_SMOKE_SOURCE=/data/scopes/users/default/apps/io.lakner.console2 \
  AURA_PREPARATION_SMOKE_START=1 node test/preparation-docker-smoke.mjs
```

Set `AURA_PREPARATION_SMOKE_RUNTIME=proot AURA_USE_PROOT=true` to exercise PRoot. `AURA_USE_PROOT=false` exercises its direct fallback. The script requires the Aura shell's runtime mounts and substitutes an empty test context; it does not start another KV service.

Core changes require a build and shell restart because the running shell consumes compiled core code. Build and verify before activation; follow the repository guide's restart confirmation requirement.
