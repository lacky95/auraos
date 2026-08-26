# ─── Stage: aura-base ─────────────────────────────────────────────────────────
# Sibling-container image used by ContainerRunner. Rooted at the FULL Debian
# Bookworm node:22 image (not -slim) so apps get the familiar Debian
# environment with apt indexes, perl, gnupg, full procps, build tools, etc.
# preinstalled — fewer `aura cap install` round-trips for everyday utilities,
# and an interactive shell behaves the way Debian users expect.
# Build with:
#   docker build -t aura-base -f Dockerfile --target aura-base .
FROM node:22 AS aura-base
# Keep the explicit `apt-get install` line for the AuraOS-specific extras
# that aren't in the full node:22 base (ssh client+server, htop, dnsutils,
# iproute2). Most of bash/coreutils/curl/git/procps/nano/less is already
# present in node:22 so this layer is small.
#
# tmux is not a user convenience here — com.aura.terminal runs every shell
# inside a tmux session so the shell's lifetime is decoupled from the PTY's
# (see apps/com.aura.terminal/tmux.conf). Without it in the image the terminal
# silently falls back to a bare shell that dies with its PTY on every app
# restart or code reload.
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-client \
    openssh-server \
    tmux \
    htop \
    lsof \
    dnsutils \
    iproute2 \
  && rm -rf /var/lib/apt/lists/*

# Zot — OCI Distribution registry, baked in so com.aura.registry doesn't
# pay a first-boot download tax (decision in plan: bake-in over fetch).
# Static linux-amd64 binary from the GitHub releases. Bump ZOT_VERSION to
# pull in upstream fixes — no source changes needed; just rebuild aura-base.
ARG ZOT_VERSION=v2.1.7
RUN curl -fsSL "https://github.com/project-zot/zot/releases/download/${ZOT_VERSION}/zot-linux-amd64-minimal" -o /usr/local/bin/zot \
 && chmod +x /usr/local/bin/zot \
 && zot --version

# ─── Stage: base-rootfs ───────────────────────────────────────────────────────
# Debian-slim filesystem with the tools an app sandbox needs, exported as a
# raw rootfs that PRoot can pivot into. Using debian-slim (not Alpine) keeps
# glibc compatibility with host-side binaries bind-mounted into the rootfs.
FROM debian:bookworm-slim AS base-rootfs

# Base-rootfs essentials — every proot inherits these at /usr/bin via its own
# rootfs (no cap-system involvement, on PATH by default). Anything more
# specialised (claude, gh, ripgrep, bun, …) stays in the toolchain store and
# is opt-in per app via `aura cap grant`.
#
# Network tooling (ssh*, nslookup), filesystem/process introspection (lsof,
# htop, ps), and a baseline editor + pager (nano, less) are present so an
# operator dropped into ANY app's terminal can debug, edit, and reach the
# outside world without first installing a thing.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    coreutils \
    curl \
    git \
    ca-certificates \
    procps \
    nodejs \
    npm \
    openssh-client \
    openssh-server \
    nano \
    less \
    htop \
    lsof \
    dnsutils \
    iproute2 \
  && rm -rf /var/lib/apt/lists/*

# ─── Stage: base ──────────────────────────────────────────────────────────────
FROM node:22-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    proot \
    bash \
    curl \
    wget \
    ca-certificates \
    git \
    procps \
    python3 \
    make \
    g++ \
    build-essential \
    libtalloc-dev \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*

# Valkey — the embedded KV store the shell spawns as a child process
# (`packages/kv-store/src/server.ts`). BSD-licensed drop-in for Redis, wire-
# and config-compatible, so `ioredis` and every consumer are unaffected.
# Copied from the official image rather than apt-installed: bookworm has no
# valkey package, and this pins the exact version. All of its shared-library
# deps (libssl3, libsystemd0, libgcrypt20, liblzma5, libzstd1, liblz4-1,
# libcap2) are already in node:22-slim's bookworm base.
COPY --from=valkey/valkey:8-bookworm /usr/local/bin/valkey-server /usr/local/bin/valkey-server
COPY --from=valkey/valkey:8-bookworm /usr/local/bin/valkey-cli    /usr/local/bin/valkey-cli

# Docker CLI — ContainerRunner uses this to drive sibling-container spawns
# via the host's docker daemon (socket bind-mounted from compose). Static
# binary from docker.com so it works on any host without adding repos.
# Arch resolved at build time via `uname -m` so the same Dockerfile produces
# a correct binary on both x86_64 hosts and Apple Silicon (linux/arm64 ⇒ aarch64).
ARG DOCKER_VERSION=29.3.1
RUN ARCH=$(uname -m) \
 && curl -fsSL "https://download.docker.com/linux/static/stable/${ARCH}/docker-${DOCKER_VERSION}.tgz" -o /tmp/docker.tgz \
 && tar -xzf /tmp/docker.tgz -C /tmp \
 && install -m 0755 /tmp/docker/docker /usr/local/bin/docker \
 && rm -rf /tmp/docker.tgz /tmp/docker \
 && docker --version

# oras — OCI Registry Access tool. Nexus uses it to push/pull both apps
# (oras push <ref> bundle.tar.gz) and @aura/* SDK packages. Static binary
# from the GitHub releases. ORAS_VERSION is build-arg-bumpable; the artifact
# format is OCI Distribution v1.1 which has been stable since 2023.
ARG ORAS_VERSION=1.2.0
RUN curl -fsSL "https://github.com/oras-project/oras/releases/download/v${ORAS_VERSION}/oras_${ORAS_VERSION}_linux_amd64.tar.gz" -o /tmp/oras.tgz \
 && tar -xzf /tmp/oras.tgz -C /tmp oras \
 && install -m 0755 /tmp/oras /usr/local/bin/oras \
 && rm -f /tmp/oras.tgz /tmp/oras \
 && oras version

# Docker Compose plugin. Needed by SELF-UPDATE (Settings → About): the updater
# runs as a sibling container from THIS image and rebuilds the shell with
# `docker compose up -d --build`, so compose has to exist inside the image —
# the static docker CLI installed above ships no plugins. Same static-binary
# approach as the docker CLI: no repos, works on any host, arch resolved at
# build time.
ARG COMPOSE_VERSION=2.40.3
RUN ARCH=$(uname -m) \
 && curl -fsSL "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${ARCH}" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose --create-dirs \
 && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
 && docker compose version

# Replace Debian's proot (5.3.x with EFAULT on Rust-compiled native modules
# like Tailwind 4 Oxide / jiti) with a fresh build from upstream proot-me.
# /usr/local/bin precedes /usr/bin in PATH, so this version wins everywhere
# `proot` is invoked by name. Without this, apps with native deps that hit
# the EFAULT bug must opt out via `useProot: false` in their manifest —
# which defeats the per-app-sandbox isolation we want.
RUN git clone --depth 1 https://github.com/proot-me/proot /tmp/proot-src \
 && make -C /tmp/proot-src/src -j$(nproc) \
 && install -m 0755 /tmp/proot-src/src/proot /usr/local/bin/proot \
 && rm -rf /tmp/proot-src

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /workspace

# ─── Stage: toolchain ─────────────────────────────────────────────────────────
# Builds /os/toolchain — shared tool layer bind-mounted into every PRoot app
FROM base AS toolchain

RUN mkdir -p /os/toolchain/bin /os/toolchain/lib

# Claude Code CLI (available globally via node from base image)
RUN npm install -g @anthropic-ai/claude-code 2>/dev/null || true

# Copy system tools into toolchain so PRoot apps can bind-mount them selectively.
# docker is here too so wildcard-cap apps (terminal) can drive sibling-container
# spawns over the host daemon — paired with a /var/run/docker.sock bind that
# ProotRunner adds when the manifest tools[] include 'docker' or '*'.
RUN cp $(which git) /os/toolchain/bin/git && \
    cp $(which curl) /os/toolchain/bin/curl && \
    cp $(which bash) /os/toolchain/bin/bash && \
    cp $(which docker) /os/toolchain/bin/docker && \
    cp $(which oras) /os/toolchain/bin/oras

# Debian-slim base rootfs for PRoot apps (shared, glibc-compatible)
COPY --from=base-rootfs / /os/base-rootfs

# ─── Stage: deps ──────────────────────────────────────────────────────────────
FROM base AS deps

COPY package.json pnpm-workspace.yaml ./

# Copy package manifests for workspace packages
COPY packages/core/package.json ./packages/core/package.json
COPY packages/kv-store/package.json ./packages/kv-store/package.json
COPY packages/shell/package.json ./packages/shell/package.json
COPY packages/app-sdk/package.json ./packages/app-sdk/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/aura-cli/package.json ./packages/aura-cli/package.json

RUN pnpm install

# ─── Stage: build ─────────────────────────────────────────────────────────────
FROM deps AS build

COPY . .

RUN pnpm --filter @aura/core build
RUN pnpm --filter @aura/kv-store build
RUN pnpm --filter @aura/ui build
RUN pnpm --filter @aura/app-sdk build
RUN pnpm --filter @aura/cli build
RUN pnpm --filter @aura/shell build

# ─── Stage: runtime ───────────────────────────────────────────────────────────
FROM base AS runtime

COPY --from=toolchain /os /os
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/core/dist ./packages/core/dist
COPY --from=build /workspace/packages/kv-store/dist ./packages/kv-store/dist
COPY --from=build /workspace/packages/ui/dist ./packages/ui/dist
COPY --from=build /workspace/packages/app-sdk/dist ./packages/app-sdk/dist
COPY --from=build /workspace/packages/shell/dist ./packages/shell/dist
COPY --from=build /workspace/packages/aura-cli/dist ./packages/aura-cli/dist
COPY apps/ ./apps/

# Install aura CLI globally + expose as a forwardable capability (bind-mountable into PRoots)
# NOTE: toolchain symlink must point directly at the .cjs file, NOT at /usr/local/bin/aura.
# When the toolchain entry is bind-mounted into a PRoot at /usr/local/bin/aura, a target of
# /usr/local/bin/aura would become a self-referential symlink inside the sandbox.
RUN ln -sf /workspace/packages/aura-cli/dist/aura.cjs /usr/local/bin/aura \
 && ln -sf /workspace/packages/aura-cli/dist/aura.cjs /os/toolchain/bin/aura

ENV NODE_ENV=development
ENV AURA_APPS_DIR=/workspace/apps
ENV AURA_DATA_DIR=/data
ENV AURA_BASE_ROOTFS=/os/base-rootfs
ENV AURA_TOOLCHAIN_DIR=/os/toolchain
ENV AURA_APP_PORT_START=4001
ENV AURA_APP_PORT_END=4999
# See the development stage / os/toolchain-path.sh: the master container runs
# the whole toolchain on PATH, sourced from the volume mirror so it survives
# a container recreate.
ENV PATH=$PATH:/data/aura/toolchain/bin
COPY os/toolchain-path.sh /etc/profile.d/aura-toolchain.sh

# See the development stage: one persistent home per identity — the master's
# own (system scope) here, the user's at /home/aura for the apps it spawns.
ENV HOME=/home/master

# Corepack caches the pnpm binary under $HOME. The image already baked one
# (`corepack prepare pnpm@latest --activate` → /root/.cache/node/corepack);
# moving HOME onto the volume orphaned it, so corepack tried to re-download
# pnpm and BLOCKED on its interactive "Do you want to continue? [Y/n]" prompt
# — compose gives this container a TTY, so nothing answered it and the OS
# never finished booting. Pin COREPACK_HOME at the image's cache: the package
# manager belongs to the IMAGE, only user/tool state belongs to the volume.
# The prompt is disabled too, so a pnpm version bump downloads unattended
# instead of hanging the boot again.
ENV COREPACK_HOME=/root/.cache/node/corepack
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

EXPOSE 3000

# AuraOS always runs in dev mode for live-reload (AI-native, always editable)
CMD ["sh", "-c", "mkdir -p /data/aura/home/master /data/aura/home/default && rm -f /home/master /home/aura && ln -s /data/aura/home/master /home/master && ln -s /data/aura/home/default /home/aura && pnpm install && pnpm --filter @aura/shell dev --host 0.0.0.0"]

# ─── Stage: development ───────────────────────────────────────────────────────
# Used by docker-compose for local dev — code is volume-mounted from host
FROM base AS development

RUN corepack enable && corepack prepare pnpm@latest --activate

ENV NODE_ENV=development
ENV AURA_APPS_DIR=/workspace/apps
ENV AURA_DATA_DIR=/data
ENV AURA_BASE_ROOTFS=/os/base-rootfs
ENV AURA_TOOLCHAIN_DIR=/os/toolchain
ENV AURA_APP_PORT_START=4001
ENV AURA_APP_PORT_END=4999

EXPOSE 3000
EXPOSE 4001-4100

# Install Claude Code + toolchain at dev image build time. The host's bash/git/curl
# are still copied into /os/toolchain/bin/ for opt-in per-app bind-mounts, but the
# base-rootfs below also has its own copies (apps default to those).
RUN npm install -g @anthropic-ai/claude-code 2>/dev/null || true && \
    mkdir -p /os/toolchain/bin && \
    cp $(which git) /os/toolchain/bin/git && \
    cp $(which curl) /os/toolchain/bin/curl && \
    cp $(which bash) /os/toolchain/bin/bash && \
    cp $(which docker) /os/toolchain/bin/docker

# Debian-slim PRoot base rootfs (glibc-compatible — same libc as host binaries)
COPY --from=base-rootfs / /os/base-rootfs

# Master-container PATH. aura-shell is the OS itself, not a sandbox, so it
# gets the whole toolchain instead of a per-app `tools[]` allowlist — see
# os/toolchain-path.sh for the reasoning and why it's the volume mirror
# rather than /os/toolchain/bin. ENV covers the shell process and its
# children plus `bash -i` (what `aura jump --master` execs); the profile.d
# copy covers LOGIN shells, where Debian's /etc/profile hard-resets root's
# PATH and would otherwise drop this. Kept as the last layers before CMD so
# editing them doesn't invalidate the expensive npm/rootfs layers above.
ENV PATH=$PATH:/data/aura/toolchain/bin
COPY os/toolchain-path.sh /etc/profile.d/aura-toolchain.sh

# Master-container HOME. The master's own filesystem is an image layer, so a
# $HOME of /root means every tool's state — `claude` logins and session
# history, `gh auth`, ssh keys, any dotfile any future tool writes — is
# destroyed by the next rebuild, recreate, or host reboot that recreates the
# container. Pointing HOME at the app-data volume makes tool state persist for
# EVERY tool at once, with no per-tool list of "paths worth keeping" to
# maintain and no work needed when a new tool shows up.
#
# Same philosophy as the user's home, DIFFERENT home: the master is the OS,
# not a user, so it gets its own home beside them (/data/aura/home/master)
# while apps get the user's (/data/aura/home/default, mounted at
# /home/aura in every sandbox). See packages/core/src/scopes/home.ts. Both
# symlinks exist here because non-prooted apps run inside this container and
# must still land in the USER's home.
#
# Symlinks rather than compose `volume-subpath` mounts: a subpath mount fails
# on a first boot when the dir doesn't exist yet. The CMD creates both dirs
# before anything reads HOME.
ENV HOME=/home/master

# Corepack caches the pnpm binary under $HOME. The image already baked one
# (`corepack prepare pnpm@latest --activate` → /root/.cache/node/corepack);
# moving HOME onto the volume orphaned it, so corepack tried to re-download
# pnpm and BLOCKED on its interactive "Do you want to continue? [Y/n]" prompt
# — compose gives this container a TTY, so nothing answered it and the OS
# never finished booting. Pin COREPACK_HOME at the image's cache: the package
# manager belongs to the IMAGE, only user/tool state belongs to the volume.
# The prompt is disabled too, so a pnpm version bump downloads unattended
# instead of hanging the boot again.
ENV COREPACK_HOME=/root/.cache/node/corepack
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /workspace

# The aura CLI is built from /workspace (volume-mounted in dev). Initial build
# + wrapper-script install + esbuild watcher in the background → every edit
# under packages/aura-cli/src/ rebuilds dist/aura.cjs in place, and the wrapper
# script always execs the current build.
#
# IMPORTANT: install /usr/local/bin/aura and /os/toolchain/bin/aura as
# wrapper SCRIPTS, not symlinks. PRoot binds the toolchain entry into each
# sandbox at /usr/local/bin/aura; if the bind source is a symlink, `lstat`
# inside the PRoot sees the destination as a symlink but `readlink` returns
# EINVAL → Node's `realpathSync` in run_main blows up. A wrapper script is
# a regular file, bind cleanly, and execs `node` with the final path so
# Node never has to readlink the bind destination.
# NOTE: every workspace package under packages/* is now consumed via its
# built dist/ (main → ./dist/index.js, @aura/app-sdk/integration →
# ./dist/integration.mjs, @aura/ui styles, …), so the shell dev server (and
# app astro.config.mjs files that import @aura/app-sdk/integration) crash on a
# fresh clone / bind-mount unless the packages are built first. Build ALL of
# packages/* via a single recursive, dependency-ordered pnpm run so this never
# drifts again when a package is added or flips to dist exports — an earlier
# hardcoded core/kv-store/cli list silently missed @aura/ui and @aura/app-sdk.
CMD ["sh", "-c", "mkdir -p /data/aura/home/master /data/aura/home/default && rm -f /home/master /home/aura && ln -s /data/aura/home/master /home/master && ln -s /data/aura/home/default /home/aura \
 && { pnpm install || echo '[aura] pnpm install exited non-zero (likely ERR_PNPM_IGNORED_BUILDS) — continuing'; } \
 && pnpm --filter \"./packages/*\" build \
 && install -D -m 0755 /workspace/os/aura-cli-shim.sh /usr/local/bin/aura \
 && install -D -m 0755 /workspace/os/aura-cli-shim.sh /os/toolchain/bin/aura \
 && install -D -m 0644 /workspace/os/bashrc.aura.sh /os/base-rootfs/root/.bashrc \
 && install -D -m 0644 /workspace/os/bashrc.aura.sh /os/base-rootfs/etc/profile.d/aura-prompt.sh \
 && install -D -m 0644 /workspace/os/bashrc.aura.sh /os/base-rootfs/etc/bash.bashrc \
 && install -D -m 0644 /workspace/os/toolchain-path.sh /etc/profile.d/aura-toolchain.sh \
 && (pnpm --filter @aura/cli build:watch &) \
 && pnpm --filter @aura/shell dev --host 0.0.0.0"]
