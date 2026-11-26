/**
 * The security options registry (D64): every security switch of AuraOS,
 * declared once, with its default, where its value comes from and what a
 * change needs. Settings, the API (`/api/admin/security-options`), the CLI
 * (`aura admin security`), the docs page "Security options" and the
 * diagnostics all read this list; none keeps its own.
 *
 * Sources:
 *   policy    writable here: one MAC-sealed, owner-only record in the private
 *             `user:` namespace (SecurityPolicyStore). A change needs the
 *             owner's `change` approval.
 *   env       set on the host (compose / .env), read where it always was;
 *             a restart applies it. Read-only here.
 *   record    its own sealed record and route (the password policy); listed
 *             here, changed where it always was.
 *   reserved  declared for the future; not yet available.
 *
 * An `envOverride` wins over the policy record.
 */

export type SecurityOptionSource = 'policy' | 'env' | 'record' | 'reserved';
export type SecurityOptionType = 'boolean' | 'enum' | 'list' | 'record';
export type SecurityOptionValue = boolean | string | readonly string[] | null;

export interface SecurityOption {
  id: string;
  title: string;
  /** Plain words: what it protects, what on and off (or each value) do. */
  description: string;
  type: SecurityOptionType;
  /** For `enum`. */
  values?: readonly string[];
  default: SecurityOptionValue;
  source: SecurityOptionSource;
  /** `env` options: the variable. Policy options: a host variable that wins, if any. */
  env?: string;
  /** `record` options: the record that holds it. */
  record?: string;
  /** A change takes effect only after `aura restart os`. */
  restartRequired: boolean;
  /** The approval level a write needs (D9): every security option is `fresh`. */
  change: 'fresh';
  /** For display. */
  since: string;
  phase: string;
}

/** The writable option behind D63: fresh confirmations over plain HTTP. */
export const FRESH_AUTH_REQUIRE_HTTPS = 'fresh-auth-require-https';

export const SECURITY_OPTIONS: readonly SecurityOption[] = Object.freeze([
  {
    id: FRESH_AUTH_REQUIRE_HTTPS,
    title: 'Require HTTPS for password confirmations',
    description: 'Off (default): a password confirmation ("fresh" approval) works in the AuraOS desktop dialog over plain HTTP too, '
      + 'and the password then crosses the network unencrypted. On: it needs HTTPS, or the host command `aura approve <id>`. '
      + 'Turn it on if AuraOS is reachable from networks you do not trust.',
    type: 'boolean', default: false, source: 'policy', restartRequired: false, change: 'fresh',
    since: '2026-11-26', phase: '3a (D63)',
  },
  {
    id: 'password-policy',
    title: 'Password policy',
    description: 'The rules for new and changed passwords: minimum length, character types, different from the username. '
      + 'Existing passwords stay valid. Changed in Settings → Users & Identities → Global.',
    type: 'record', default: null, source: 'record', record: 'user:policy:password', restartRequired: false, change: 'fresh',
    since: '2026-11-24', phase: '3a',
  },
  {
    id: 'access-enforce',
    title: 'Access enforcement',
    description: 'What the route access manifest does. off: no access report. report (default): every decision is counted in '
      + '`aura admin access-report`, nothing is refused because of it. enforce: what the manifest denies is refused. '
      + 'App Host gateway calls are enforced in every mode.',
    type: 'enum', values: ['off', 'report', 'enforce'], default: 'report', source: 'env', env: 'AURA_ACCESS_ENFORCE',
    restartRequired: true, change: 'fresh', since: '2026-11-24', phase: '3a',
  },
  {
    id: 'lifecycle-strict',
    title: 'Lifecycle checks',
    description: 'How an app start treats a failed lifecycle check (health endpoint guard, declared hooks). '
      + 'warn (default): the app starts and the finding is reported. strict: the start is refused.',
    type: 'enum', values: ['warn', 'strict'], default: 'warn', source: 'env', env: 'AURA_LIFECYCLE_STRICT',
    restartRequired: true, change: 'fresh', since: '2026-11-25', phase: '3b',
  },
  {
    id: 'host-policy',
    title: 'Host check',
    description: 'Which addresses the shell answers on (DNS rebinding protection). enforce (default): a malformed address, '
      + 'or a custom domain not in AURA_DESKTOP_HOSTS, is refused. report: it is served and logged.',
    type: 'enum', values: ['enforce', 'report'], default: 'enforce', source: 'env', env: 'AURA_HOST_POLICY',
    restartRequired: true, change: 'fresh', since: '2026-11-22', phase: '2',
  },
  {
    id: 'desktop-hosts',
    title: 'Custom desktop domains',
    description: 'Custom domains this AuraOS is opened at (comma-separated); their App Hosts follow. '
      + 'IP addresses, localhost and nip.io names need no entry. Empty (default): no custom domain is served.',
    type: 'list', default: [], source: 'env', env: 'AURA_DESKTOP_HOSTS',
    restartRequired: true, change: 'fresh', since: '2026-11-22', phase: '2',
  },
  {
    id: 'trusted-proxies',
    title: 'Trusted proxies',
    description: 'Peer addresses whose X-Forwarded-Proto, -Host and -For headers count (a TLS proxy in front of AuraOS). '
      + 'Empty (default): nobody is trusted, so a request counts as HTTPS only when it really is.',
    type: 'list', default: [], source: 'env', env: 'AURA_TRUSTED_PROXIES',
    restartRequired: true, change: 'fresh', since: '2026-11-22', phase: '2',
  },
  {
    id: 'access-profile',
    title: 'Access profile',
    description: 'Open (the alpha) or Zero Trust (every app call needs an explicit grant). Not yet available: '
      + 'a future installer option (5.11).',
    type: 'enum', values: ['open', 'zero-trust'], default: 'open', source: 'reserved',
    restartRequired: false, change: 'fresh', since: '2026-11-26', phase: 'later',
  },
].map((o) => Object.freeze(o as SecurityOption)));

export const securityOption = (id: string): SecurityOption | undefined => SECURITY_OPTIONS.find((o) => o.id === id);

/** The ids a policy record may hold. */
export const POLICY_OPTION_IDS: readonly string[] = SECURITY_OPTIONS.filter((o) => o.source === 'policy').map((o) => o.id);

/** The stored values of the `policy` options; a missing id is its default. */
export type SecurityPolicy = Record<string, boolean | string>;

/** A valid value of a `policy` option from untrusted input, or undefined. */
export function parseOptionValue(option: SecurityOption, raw: unknown): boolean | string | undefined {
  if (option.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') {
      const v = raw.trim().toLowerCase();
      if (['true', 'on', '1', 'yes'].includes(v)) return true;
      if (['false', 'off', '0', 'no'].includes(v)) return false;
    }
    return undefined;
  }
  if (option.type === 'enum' && typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    return option.values?.includes(v) ? v : undefined;
  }
  return undefined;
}

/** The policy values from a stored record: known ids with valid values only. */
export function parseSecurityPolicy(input: unknown): SecurityPolicy | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: SecurityPolicy = {};
  for (const [id, raw] of Object.entries(input as Record<string, unknown>)) {
    const option = securityOption(id);
    if (!option || option.source !== 'policy') return null;
    const v = parseOptionValue(option, raw);
    if (v === undefined) return null;
    out[id] = v;
  }
  return out;
}

/**
 * An `env` value as its read point parses it: unset or empty is the default;
 * an enum is trimmed and lowercased, anything unknown is the default.
 */
export function envOptionValue(option: SecurityOption, raw: string | undefined): { value: SecurityOptionValue; valid: boolean } {
  const text = (raw ?? '').trim();
  if (option.type === 'list') {
    return { value: text.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean), valid: true };
  }
  if (text === '') return { value: option.default, valid: true };
  if (option.type === 'enum') {
    const v = text.toLowerCase();
    return option.values?.includes(v) ? { value: v, valid: true } : { value: option.default, valid: false };
  }
  if (option.type === 'boolean') {
    const v = parseOptionValue(option, text);
    return v === undefined ? { value: option.default, valid: false } : { value: v, valid: true };
  }
  return { value: option.default, valid: true };
}

/** The value of one `env` option in this process. */
export function securityEnvValue(id: string, env: Record<string, string | undefined> = process.env): SecurityOptionValue {
  const option = securityOption(id);
  if (!option?.env) throw new Error(`not an env security option: ${id}`);
  return envOptionValue(option, env[option.env]).value;
}

export interface EffectiveSecurityOption extends SecurityOption {
  value: SecurityOptionValue;
  /** `default`, `policy`, `env AURA_X`, `record user:policy:…` or `reserved`. */
  effectiveSource: string;
  writable: boolean;
  /** An env value that is not one of `values`: the default applies (its read point logs it). */
  invalidEnv?: true;
}

/**
 * Every option's effective value and where it comes from. A host variable
 * wins; then the policy record; then the default.
 */
export function resolveSecurityOptions(
  policy: SecurityPolicy,
  env: Record<string, string | undefined> = process.env,
): EffectiveSecurityOption[] {
  return SECURITY_OPTIONS.map((o) => {
    const writable = o.source === 'policy';
    if (o.env && (env[o.env] ?? '').trim() !== '') {
      const { value, valid } = envOptionValue(o, env[o.env]);
      return { ...o, value, effectiveSource: `env ${o.env}`, writable, ...(valid ? {} : { invalidEnv: true as const }) };
    }
    if (o.source === 'policy' && policy[o.id] !== undefined) {
      return { ...o, value: policy[o.id]!, effectiveSource: 'policy', writable };
    }
    if (o.source === 'record') return { ...o, value: o.default, effectiveSource: `record ${o.record}`, writable };
    if (o.source === 'reserved') return { ...o, value: o.default, effectiveSource: 'reserved', writable };
    return { ...o, value: o.default, effectiveSource: 'default', writable };
  });
}

/** The effective value of one `policy` option (a host variable wins). */
export function securityPolicyValue(
  policy: SecurityPolicy, id: string, env: Record<string, string | undefined> = process.env,
): SecurityOptionValue {
  const found = resolveSecurityOptions(policy, env).find((o) => o.id === id);
  if (!found) throw new Error(`unknown security option: ${id}`);
  return found.value;
}
