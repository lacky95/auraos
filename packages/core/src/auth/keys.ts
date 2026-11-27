/**
 * Valkey keys the `auth` module owns (D97 A3, `kv-owner`): no other module
 * writes a literal with these prefixes; others call auth's services. Covers
 * `identity/` and `permissions/` by pointer (their keys are auth's). The
 * `user:<id>:…` space is shared with security, runtimes and capabilities
 * (packages/core/AGENTS.md), so only auth's own `user:` key is listed.
 * A contract leaf.
 */
export const AUTH_KV_PREFIXES = ['usersess:', 'grant:', 'apikey:', 'audit:admin', 'user:policy:password'] as const;

/** The password policy record (`passwordPolicy.ts`); named by the D64 options registry. */
export const PASSWORD_POLICY_KEY = 'user:policy:password';
