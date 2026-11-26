/**
 * The Docker socket's path (stream J.7, D54/D55).
 *
 * No app, sidecar or Terminal sandbox gets `/var/run/docker.sock` at spawn,
 * whatever its `tools[]` says (a manifest that lists `docker` gets a contract
 * warning, contract/appContract.ts). The socket exists only in the shell and
 * in a root tab's own mount namespace (`aura root`, J.6: the session broker
 * clones it there). There is no spawn argument for it any more.
 */
export const DOCKER_SOCKET_PATH = '/var/run/docker.sock';
