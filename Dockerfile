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

# Minimal Alpine-based rootfs for PRoot apps (shared base)
RUN mkdir -p /os/base-rootfs && \
    curl -fsSL https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-minirootfs-3.20.0-x86_64.tar.gz \
    | tar -xz -C /os/base-rootfs

# ─── Stage: deps ──────────────────────────────────────────────────────────────
FROM base AS deps

COPY package.json pnpm-workspace.yaml ./

# Copy package manifests for workspace packages
COPY packages/core/package.json ./packages/core/package.json
COPY packages/shell/package.json ./packages/shell/package.json
COPY packages/app-sdk/package.json ./packages/app-sdk/package.json
COPY packages/ui/package.json ./packages/ui/package.json

RUN pnpm install

# ─── Stage: build ─────────────────────────────────────────────────────────────
FROM deps AS build

COPY . .

RUN pnpm --filter @aura/core build
RUN pnpm --filter @aura/ui build
RUN pnpm --filter @aura/app-sdk build
RUN pnpm --filter @aura/shell build

# ─── Stage: runtime ───────────────────────────────────────────────────────────
FROM base AS runtime

COPY --from=toolchain /os /os
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/core/dist ./packages/core/dist
COPY --from=build /workspace/packages/ui/dist ./packages/ui/dist
COPY --from=build /workspace/packages/app-sdk/dist ./packages/app-sdk/dist
COPY --from=build /workspace/packages/shell/dist ./packages/shell/dist
COPY apps/ ./apps/

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

# Install Claude Code + toolchain at dev image build time
RUN npm install -g @anthropic-ai/claude-code 2>/dev/null || true && \
    mkdir -p /os/toolchain/bin && \
    cp $(which git) /os/toolchain/bin/git && \
    cp $(which curl) /os/toolchain/bin/curl && \
    cp $(which bash) /os/toolchain/bin/bash

# Download Alpine minirootfs for PRoot base
RUN mkdir -p /os/base-rootfs && \
    curl -fsSL https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-minirootfs-3.20.0-x86_64.tar.gz \
    | tar -xz -C /os/base-rootfs

WORKDIR /workspace

CMD ["sh", "-c", "pnpm install && pnpm --filter @aura/shell dev --host 0.0.0.0"]
