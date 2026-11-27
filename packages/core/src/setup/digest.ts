/**
 * The two digests of a setup configuration (D108 §2.4, decision 9), in the
 * `executionDigest` pattern (identity/execution.ts): `sha256:<hex>` over a
 * canonical JSON form, so they are stable across key order and runs.
 *
 *   configDigest  the whole requested/effective configuration; secrets count
 *                 by field NAME only (a vault handle's identity never enters
 *                 a digest, so rotating a handle is not a configuration change
 *                 and no handle can be recovered from a digest)
 *   grantDigest   only the privilege-bearing part (`GrantBearing`): what an
 *                 `app.setup.apply` approval binds. A plain value change
 *                 leaves it unchanged; a permission, home, scope, network or
 *                 resource change moves it.
 *
 * The canonical form is local: `approvals/state.ts` has the same idea but is
 * not a contract leaf, and importing it would make setup → approvals →
 * setup/contracts a module cycle.
 */
import { createHash } from 'node:crypto';
import type { EffectiveConfig, GrantBearing } from './contracts.js';

/** JSON with object keys sorted, `undefined` members left out; throws on anything JSON can't carry unchanged. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown, path: string): string => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'string': return JSON.stringify(v);
      case 'boolean': return v ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(v)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
        return JSON.stringify(v);
      case 'object': break;
      default: throw new TypeError(`canonicalJson: ${typeof v} at ${path}`);
    }
    if (Array.isArray(v)) return `[${v.map((item, i) => walk(item ?? null, `${path}[${i}]`)).join(',')}]`;
    const rec = v as Record<string, unknown>;
    const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${walk(rec[k], `${path}.${k}`)}`).join(',')}}`;
  };
  return walk(value, '$');
}

const sha256 = (value: unknown): string => `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;

/** A configuration as the digests see it (the resolver's `requested`, or an `EffectiveConfig`). */
export type DigestableConfig = Omit<EffectiveConfig, 'configDigest' | 'grantDigest' | 'degraded'>;

/** The privilege-bearing part of a configuration (`GrantBearing`), lists sorted. */
export function grantBearingOf(c: GrantBearing): GrantBearing {
  const sorted = (xs: readonly string[]) => [...new Set(xs)].sort();
  return {
    permissions: sorted(c.permissions),
    tools: sorted(c.tools),
    context: sorted(c.context),
    homeEnvironment: c.homeEnvironment,
    ownerEnvironmentSidecars: sorted(c.ownerEnvironmentSidecars),
    instanceScope: c.instanceScope,
    environmentScope: c.environmentScope,
    sandbox: c.sandbox,
    networks: { ...c.networks },
    resources: c.resources ? { ...c.resources } : null,
  };
}

/** `sha256:<hex>` of the configuration, secret handles by field name only. */
export function configDigestOf(c: DigestableConfig): string {
  const { secrets, ...rest } = c;
  return sha256({ v: 1, ...rest, ...grantBearingOf(c), secrets: Object.keys(secrets).sort() });
}

/** `sha256:<hex>` of the privilege-bearing part. */
export function grantDigestOf(c: GrantBearing): string {
  return sha256({ v: 1, ...grantBearingOf(c) });
}
