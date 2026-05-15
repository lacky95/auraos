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
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /workspace

# ─── Stage: toolchain ─────────────────────────────────────────────────────────
# Builds /os/toolchain — shared tool layer bind-mounted into every PRoot app
FROM base AS toolchain

RUN mkdir -p /os/toolchain/bin /os/toolchain/lib

# Claude Code CLI (available globally via node from base image)
RUN npm install -g @anthropic-ai/claude-code 2>/dev/null || true

# Copy system tools into toolchain so PRoot apps can bind-mount them selectively
RUN cp $(which git) /os/toolchain/bin/git && \
    cp $(which curl) /os/toolchain/bin/curl && \
    cp $(which bash) /os/toolchain/bin/bash

# Debian-slim base rootfs for PRoot apps (shared, glibc-compatible)
COPY --from=base-rootfs / /os/base-rootfs

# ─── Stage: deps ──────────────────────────────────────────────────────────────
FROM base AS deps

COPY package.json pnpm-workspace.yaml ./

# Copy package manifests for workspace packages
COPY packages/core/package.json ./packages/core/package.json
COPY packages/shell/package.json ./packages/shell/package.json
COPY packages/app-sdk/package.json ./packages/app-sdk/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/aura-cli/package.json ./packages/aura-cli/package.json

RUN pnpm install

# ─── Stage: build ─────────────────────────────────────────────────────────────
FROM deps AS build

COPY . .

RUN pnpm --filter @aura/core build
RUN pnpm --filter @aura/ui build
RUN pnpm --filter @aura/app-sdk build
RUN pnpm --filter @aura/cli build
RUN pnpm --filter @aura/shell build

# ─── Stage: runtime ───────────────────────────────────────────────────────────
FROM base AS runtime

COPY --from=toolchain /os /os
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/core/dist ./packages/core/dist
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

EXPOSE 3000

# AuraOS always runs in dev mode for live-reload (AI-native, always editable)
CMD ["sh", "-c", "pnpm install && pnpm --filter @aura/shell dev --host 0.0.0.0"]

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
    cp $(which bash) /os/toolchain/bin/bash

# Debian-slim PRoot base rootfs (glibc-compatible — same libc as host binaries)
COPY --from=base-rootfs / /os/base-rootfs

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
CMD ["sh", "-c", "pnpm install \
 && pnpm --filter @aura/cli build \
 && install -D -m 0755 /workspace/os/aura-cli-shim.sh /usr/local/bin/aura \
 && install -D -m 0755 /workspace/os/aura-cli-shim.sh /os/toolchain/bin/aura \
 && install -D -m 0644 /workspace/os/bashrc.aura.sh /os/base-rootfs/root/.bashrc \
 && install -D -m 0644 /workspace/os/bashrc.aura.sh /os/base-rootfs/etc/profile.d/aura-prompt.sh \
 && (pnpm --filter @aura/cli build:watch &) \
 && pnpm --filter @aura/shell dev --host 0.0.0.0"]
