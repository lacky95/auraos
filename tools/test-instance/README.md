# AuraOS test instance

Run the test instance on a **separate VM or Docker host**. Do not run it on the live Docker daemon.

## Why the same daemon is unsupported

AuraOS treats its Docker daemon as its own. A second instance on the live daemon would adopt or delete the live `aura-*` containers (`ContainerRunner.ts`, `AppManager.ts`, `SidecarManager.ts`, `PortManager.ts`). The names `aura-shell` and `aura-net` are fixed in `docker-compose.yml`, and no environment variable isolates them.

The shell also gets root-equivalent access through its Docker socket, and `docker-compose.yml` sets `AURA_AUTH_MODE: none`. So:

- Never give the test instance the live host's `/var/run/docker.sock`.
- Never run its `docker compose` with `DOCKER_HOST` or a context that points at the live daemon. The compose socket mount resolves on whichever daemon runs it.
- Never publish its port on an untrusted network.

## Prerequisites

- A Linux VM or host with its own Docker Engine and a current Compose v2 that supports `!override` (checked with v2.40.3).
- Named volumes with `volume-subpath` support, which AuraOS uses for app mounts (Docker Engine 26 or later).
- Disk for the images, the checkout, and the data copy.
- `bash`, GNU `find`, `tar`, and coreutils wherever you run these tools.

If you clone a VM image, give it a new Docker engine ID. A cloned ID makes the preflight refuse.

## 1. Record the daemon IDs

On the **live host**:

```sh
docker info --format '{{.ID}}'                # LIVE_ID
docker exec aura-shell git -C /workspace rev-parse HEAD   # COMMIT
```

On the **test host**, set both values and record the test daemon's ID:

```sh
export LIVE_ID=<live id> COMMIT=<commit>
export TEST_ID=$(docker info --format '{{.ID}}')
```

## 2. Install from the current commit

Run everything on the test host, so compose bind paths resolve there.

```sh
sudo install -d -o "$USER" /srv/auraos-test
git clone <https-repo-url> /srv/auraos-test
cd /srv/auraos-test
git checkout --detach "$COMMIT"
```

Do not copy Git credentials to this host. Use a read-only HTTPS remote.

## 3. Choose the port and URL

The shell listens on port 3000 in its container. Bind it to loopback with a compose override, which Git already ignores:

```sh
cat > docker-compose.override.yml <<'YML'
services:
  aura-os:
    ports: !override
      - "127.0.0.1:3000:3000"
YML
cat > .env <<'ENV'
COMPOSE_PROJECT_NAME=aura-test
AURA_HOST_WORKSPACE=/srv/auraos-test
ENV
```

From your workstation, open a tunnel and use `http://127.0.0.1:13000`:

```sh
ssh -N -L 13000:127.0.0.1:3000 user@test-vm
```

Keep app ports (4001-4999) closed at the VM firewall as well.

## 4. Verify isolation before first boot

```sh
tools/test-instance/check-isolation.sh \
  --docker-host unix:///var/run/docker.sock --live-id "$LIVE_ID"
```

| Exit code | Meaning |
|---|---|
| `0` | A different daemon with no AuraOS resources |
| `1` | Refused: the live daemon, or existing AuraOS resources |
| `2` | Could not verify. Treat as unsafe |

The script is read-only. It runs `docker info`, `ps`, `volume ls`, and `network ls`. Do not continue unless it exits `0`.

After first boot, the test daemon has AuraOS resources. Pass the ID you recorded **before** first boot with `--allow-test-instance "$TEST_ID"`. This flag cannot accept the live daemon ID.

## 5. Create a data copy (optional)

Skip this for a clean instance. Valkey is live on a running system, so never copy a running `/data`.

Use one of these sources:

1. **Filesystem or VM snapshot (preferred).** Take an atomic snapshot of the volume that holds `/data` and mount it read-only. Find the volume path on the live host with `docker volume inspect -f '{{.Mountpoint}}' <project>_aura-app-data`.
2. **Stopped instance.** In a planned maintenance window, stop the shell **and** every sibling app and sidecar container. Sibling containers also write to this volume.

Preview first, then apply:

```sh
tools/test-instance/copy-data.sh --source /mnt/aura-snapshot --dest /srv/aura-copy
tools/test-instance/copy-data.sh --source /mnt/aura-snapshot --dest /srv/aura-copy \
  --apply --confirm-stopped-snapshot
```

`--confirm-stopped-snapshot` overrides heuristics only, such as recent KV writes. The script always refuses if it observes a Valkey process or running container on the source.

**What is copied:** `scopes/`, `apps/`, and `nexus/`. Everything else is left behind.

**Always excluded:** `aura/secrets/`, `context/.masterkey`, `kv-redis-backup.orig`, `kv-migration.json`, `aura/runtime`, `aura/mounts`, `aura/warm-pool.json`, `aura/boot`, and `aura/update`.

**Optional:**

- `--include-kv` copies `kv/`.
- `--include-homes` copies `aura/home/*`, without `.ssh`, `.docker`, `.claude*`, `.codex`, `.config`, `.gitconfig`, shell histories, `.netrc`, `.git-credentials`, and other common credential stores, at any depth.

**The master key and KV are a pair.** Context values in KV are sealed with `context/.masterkey`. By default both are excluded, so **Context secrets are not copied**. With `--include-kv`, the sealed values are present but cannot be decrypted, and AuraOS generates a new key.

**App data may still embed tokens** in databases, caches, or logs. The script flags files with credential-like names, but it cannot detect tokens inside files. Review the copy and keep it private.

Symlinks are kept only if they are relative and resolve inside copied data. Hardlinks to excluded files, sockets, FIFOs, and devices are not copied.

Move the copy to the test host if you made it elsewhere, then seed the volume **before first boot**:

```sh
docker compose build
docker compose create
docker run --rm -v aura-test_aura-app-data:/data -v /srv/aura-copy:/src:ro \
  --entrypoint sh aura-base -c 'find /src -mindepth 1 -maxdepth 1 -exec cp -a {} /data/ \;'
```

## 6. First boot

```sh
docker compose up -d --build aura-os
docker compose logs -f aura-os
```

Run the smoke test from a checkout that includes `tools/smoke`:

```sh
pnpm smoke --target http://127.0.0.1:13000 --tier test-instance
```

Because the instance has no Context secrets, apps that need them may fail until you add test-only values.

Do not use Settings → Update on the test instance unless you are testing updates. It fetches from the checkout's Git remote.

## Nested Docker caveats

Prefer a VM. If the test daemon runs inside a container (Docker-in-Docker):

- **`AURA_HOST_WORKSPACE` must be a path the test daemon can see.** `ContainerRunner` passes it to `docker -v` as the bind source for system apps. Compose defaults it to `$PWD`. If the path exists only outside the nested daemon, Docker creates an empty directory and apps see an empty `/workspace`. Run compose inside the nested environment, from the checkout at that path.
- **The socket must be the nested daemon's.** The compose mount `/var/run/docker.sock` resolves in the daemon's filesystem. Check it with step 4.
- **Cross-app mounts need mount propagation.** `canPropagateMounts()` (`ContainerRunner.ts:419`) requires `/data` in the shell to be `shared:` or `master:`. `MountManager` also starts a privileged helper with `-v /:/host:rshared`, which needs the daemon's `/` to be a shared mount. In the nested environment, run `mount --make-rshared /` before starting its daemon. Verify from the test host:

  ```sh
  docker exec aura-shell grep ' /data ' /proc/self/mountinfo
  ```

  The line must include `shared:` or `master:`. If not, mounts are reported as unavailable.

## Reset and destroy

Run these **on the test host only**. Each block starts with the guard, so a failed check stops it.

**Reset** (removes containers and data, keeps the checkout and copy):

```sh
cd /srv/auraos-test
tools/test-instance/check-isolation.sh --docker-host unix:///var/run/docker.sock \
  --live-id "$LIVE_ID" --allow-test-instance "$TEST_ID" || exit 1
docker compose stop aura-os
{ docker ps -aq --filter 'name=^aura-'; docker ps -aq --filter label=aura.parent; } \
  | sort -u | xargs -r docker rm -f
docker compose down -v --remove-orphans
```

Then repeat the seed step and first boot.

**Destroy:** run the reset, then remove the local files and images, or delete the VM:

```sh
docker image rm aura-base aura-test-aura-os
sudo rm -rf /srv/auraos-test /srv/aura-copy
```
