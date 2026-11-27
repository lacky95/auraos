/**
 * The workload environment's two halves (philosophy audit N4, 5b): every
 * `AURA_*` variable the kernel sets in an app's environment (spawn/*Args.ts,
 * the runners) is on exactly one of these lists. A golden test
 * (core test/golden-spawn-args.test.mjs) checks every variable the spawn args
 * set against them, so a new kernel-set variable can't reach a session
 * unnoticed (fail closed).
 *
 * Published through `@aura/core/workload-env` (and the SDK's
 * `@aura/app-sdk/workload-env`): a session host (the System Terminal) scrubs
 * `SERVER_ONLY_ENV` from every session's environment. A denylist on purpose:
 * the environment also carries the user's Context keys, which an allowlist
 * would drop.
 *
 * A contract leaf: no imports.
 */

/** Kernel-set variables only the app's own server may see: secrets and server settings. */
export const SERVER_ONLY_ENV: readonly string[] = Object.freeze([
  // D28/D89 B4: keys the shell's relay claims and the hook tokens.
  'AURA_LIFECYCLE_TOKEN', 'AURA_LIFECYCLE_TOKEN_FILE',
  // The server's own relay and listen settings.
  'AURA_RELAY_STRICT', 'AURA_LISTEN_SUBNET', 'AURA_SHELL_PEERS', 'AURA_SERVE',
  // A session host's server only (spawn/sessionArgs.ts, T2): its build mode and the session launcher.
  'AURA_SESSION_HOST', 'AURA_TERM_LAUNCH', 'AURA_TERM_TMUX_BIN', 'AURA_TERM_TAP_DIR',
]);

/** Kernel-set variables a session in the instance may see (the `aura` CLI and tools use them). */
export const SESSION_VISIBLE_ENV: readonly string[] = Object.freeze([
  'AURA_INSTANCE_TOKEN', 'AURA_HOSTNAME', 'AURA_SHELL_HOSTNAME', 'AURA_RUN_AS', 'AURA_SESSION_USER', 'AURA_SESSION_UID', 'AURA_TOOLS_MODE',
  'AURA_LAYER_TAG', 'AURA_MOUNT_ROOT', 'AURA_APP_DATA_VOLUME', 'AURA_APP_DATA_SUBPATH',
]);
