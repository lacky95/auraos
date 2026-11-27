# The release builder's runner (Phase 6 stream B): what os/release/builder.mjs
# needs and nothing else (node, git, the docker CLI with buildx, Phase 7a's
# rename-exchange helper), so a Normal install needs only Docker + Compose on
# the host. install.sh builds it from ITS OWN copy (context: os/), with the
# base images rewritten through the D94 OCI mirrors, and runs the builder in
# it with the Docker socket and the data volume, --network none (the builder
# needs no network: it fetches from the host mirror, and image pulls are the
# daemon's). Base images are pinned by tag; the tag of the runner image is a
# fingerprint of this file, the two base refs and the helper source.
ARG NODE_IMAGE=node:22.23.5-bookworm
ARG DOCKER_CLI_IMAGE=docker:29.3.1-cli
FROM ${DOCKER_CLI_IMAGE} AS cli

FROM ${NODE_IMAGE}
COPY --from=cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
# One helper for durable renames and exchanges (durable.mjs), at the shell image's path.
COPY rename-exchange/ /os/rename-exchange/
RUN cc -std=gnu11 -O2 -Wall -Wextra -Werror -static -o /os/rename-exchange/aura-rename-exchange /os/rename-exchange/rename-exchange.c \
 && docker --version && docker buildx version && git --version && node --version
LABEL org.auraos.role="release-builder-runner"
