/**
 * The Docker socket in an app sandbox (Phase 5 Stage 1 extraction; stream J
 * owns this file and removes the socket from apps and Terminals, D54/D55).
 *
 * Bound when the manifest grants `docker` (explicitly or through `*`) and the
 * shell has the socket, so `docker` invocations inside the sandbox (e.g.
 * `aura jump` from the Terminal) reach the daemon the shell uses.
 */
import { existsSync } from 'node:fs';
import { toolsGrant } from '../tool-allowlist.js';

export const DOCKER_SOCKET_PATH = '/var/run/docker.sock';

function wantsSocket(tools: readonly string[] | undefined, present: boolean): boolean {
  return toolsGrant([...(tools ?? [])], 'docker') && present;
}

export function containerSocketArgs(tools: readonly string[] | undefined, present = existsSync(DOCKER_SOCKET_PATH)): string[] {
  return wantsSocket(tools, present) ? ['-v', `${DOCKER_SOCKET_PATH}:${DOCKER_SOCKET_PATH}`] : [];
}

export function prootSocketBinds(tools: readonly string[] | undefined, present = existsSync(DOCKER_SOCKET_PATH)): string[] {
  return wantsSocket(tools, present) ? [`--bind=${DOCKER_SOCKET_PATH}:${DOCKER_SOCKET_PATH}`] : [];
}
