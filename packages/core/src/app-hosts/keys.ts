/**
 * Valkey keys the `app-hosts` module owns (D97 A3, `kv-owner`): App Host
 * records, installations and host claims (`AppHostRegistry`). The `grant:`
 * keys it mentions belong to `auth` (review misalignment 3: a reference in a
 * comment, no access). A contract leaf.
 */
export const APP_HOSTS_KV_PREFIXES = ['apphost:', 'hosts:'] as const;

/** Where an installation's record lives (named by the D64 options registry for `app-run-as`). */
export const APP_INSTALLATION_KEY_DOC = 'apphost:install:<installationId>';
