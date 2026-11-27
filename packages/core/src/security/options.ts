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
 *   file      its own switch file under the data dir and its own route
 *             (system mode, shell mode); an `env` variable wins over it.
 *             Listed here, changed where it always was.
 *   reserved  declared for the future; not yet available.
 *
 * An `envOverride` wins over the policy record.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type SecurityOptionSource = 'policy' | 'env' | 'record' | 'file' | 'reserved';
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
  /** `file` options: the switch file, relative to the data dir (`AURA_DATA_DIR`, /data). */
  file?: string;
  /** A change takes effect only after `aura restart os`. */
  restartRequired: boolean;
  /**
   * The approval level a write needs (D9): `fresh` (the password). The one
   * exception is the shell mode's one click (`session`, D57).
   */
  change: 'fresh' | 'session';
  /** For display. */
  since: string;
  phase: string;
}

/** The writable option behind D63: fresh confirmations over plain HTTP. */
export const FRESH_AUTH_REQUIRE_HTTPS = 'fresh-auth-require-https';

/** The host switch behind the proot runtime (`AURA_USE_PROOT`, D92). */
export const PROOT_HOST = 'proot-host';

/** Phase 6 Stage 1b (D71, owner answer c): the release update options; stream U reads them. */
export const UPDATE_CHANNEL = 'update-channel';
export const SECURITY_UPDATE_POLICY = 'security-update-policy';
export const RELEASE_AUTO_UPDATE = 'release-auto-update';
export const RELEASE_TRUSTED_KEYS = 'release-trusted-keys';
/** D94 infrastructure switches (IC-6; the config itself is /data/aura/infra/config.yaml). */
export const INFRA_PUBLIC_FALLBACK = 'infra-public-fallback';
export const INFRA_PROXY = 'infra-proxy';
export const INFRA_INHERIT = 'infra-inherit';
export const INFRA_PUBLIC_ROOTS = 'infra-public-roots';
export const INFRA_CREDENTIAL_GRANTS = 'infra-credential-grants';

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
    id: 'relay-strict',
    title: 'Shell relay claim',
    description: 'How the Terminal and aurashelld treat a call from the shell\'s address without a valid relay claim '
      + '(x-aura-relay, signed per app start; D28/D89 B4). strict (default since 5-main): it is refused; the address '
      + 'alone never proves the shell relayed it. warn: it is served and reported in the app\'s log (the 5-pre2 '
      + 'migration period; a rollback aid only). Applies to app starts after the change.',
    type: 'enum', values: ['warn', 'strict'], default: 'strict', source: 'env', env: 'AURA_RELAY_STRICT',
    restartRequired: true, change: 'fresh', since: '2026-11-26', phase: '5-pre2 (D89 B4), strict by default in 5-main',
  },
  {
    id: 'terminal-root-transition',
    title: 'Terminal root transition (5-main deploy only)',
    description: 'The one migration exception of stream T. deploy: while the 5-main deploy migrates the owner\'s Private '
      + 'Home to uid 1000, the owner\'s System Terminal may still start as root if that home is still root\'s. Honoured '
      + 'only for a root-owned switch file written less than 6 hours ago, and never for a member. off (default, and once '
      + 'the window has passed): a Terminal whose user\'s home is not theirs yet does not start (no root fallback); '
      + 'run `aura admin homes ownership --dry-run`, then `--apply <digest>` (from the host if need be).',
    type: 'enum', values: ['off', 'deploy'], default: 'off', source: 'file', file: 'aura/terminal-root-transition',
    restartRequired: false, change: 'fresh', since: '2026-11-26', phase: '5-main (stream T)',
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
    id: 'system-mode',
    title: 'System mode',
    description: 'developer: AuraOS runs from its /workspace checkout, `aura mount workspace` and '
      + '`aura dev rebuild|restart` work, and the desktop shows the "Developer mode" badge. normal: those are refused '
      + '(the locked release comes with Phase 6). Turning it on needs the password; turning it off '
      + 'lists what differs from the release first. Settings → System, or `aura mode`. Default normal (Phase 6): '
      + 'an install whose /workspace is a git checkout gets developer written at boot, so existing installs keep it (D60).',
    type: 'enum', values: ['normal', 'developer'], default: 'normal', source: 'file', file: 'aura/system-mode',
    env: 'AURA_SYSTEM_MODE', restartRequired: false, change: 'fresh', since: '2026-11-25', phase: '4 (D60)',
  },
  {
    id: 'shell-mode',
    title: 'Shell mode',
    description: 'dev (default): the shell runs `astro dev` from source (Vite, HMR). prod: the shell\'s production build '
      + '(packages/shell/server.mjs), no dev server. Takes effect on the next `aura restart os`. `aura shell mode`; '
      + 'one approval click (D57).',
    type: 'enum', values: ['dev', 'prod'], default: 'dev', source: 'file', file: 'aura/shell-mode',
    env: 'AURA_SHELL_MODE', restartRequired: true, change: 'session', since: '2026-10-30', phase: 'early',
  },
  {
    id: 'composition',
    title: 'Build composition',
    description: 'desktop (default): the server layer plus the Web Shell (desktop pages, client bundle). server: the same '
      + 'kernel, API, App Hosts and WS proxy with no Web Shell (Headless, D76); Web Shell boot hooks (desktop session '
      + 'restore, free-flight windows) do not run. The env wins over the file; read by os/boot.sh at build and at boot (a prod build of the other composition is rebuilt); shown in /data/aura/boot/status.json.',
    type: 'enum', values: ['server', 'desktop'], default: 'desktop', source: 'file', file: 'aura/composition',
    env: 'AURA_COMPOSITION', restartRequired: true, change: 'fresh', since: '2026-11-27', phase: '6 (D76)',
  },
  {
    id: 'runtimes',
    title: 'App runtimes',
    description: 'Which runtimes apps may run in (container, PRoot), the default for apps that name none, each runtime\'s '
      + 'settings, and the per-installation overrides (ARI). A change applies to the next start of an app; an unknown or '
      + 'disabled runtime is refused, never replaced. Changed in Settings → Runtimes or with `aura runtime` '
      + '(Phase 5, the runtime release).',
    type: 'record', default: null, source: 'record', record: 'user:policy:runtimes', restartRequired: false, change: 'fresh',
    since: '2026-11-26', phase: '5 (ARI, Q1)',
  },
  {
    id: 'app-run-as',
    title: 'App identity (runAs, per installation)',
    description: 'How an installed app\'s processes run. app: as the installation\'s own app identity (uid 200000+), with no '
      + 'capabilities and no-new-privileges; its data is owned by that identity and its source stays root-owned. root: as before. '
      + 'Installations recorded before 5-apps run as root; new installations start as app (built-in apps stay root until the owner '
      + 'flips them). A failed app start is never retried as root. Changed per app with `aura admin apps run-as <app> app|root`; '
      + '`aura admin apps privileges` is the review (Phase 5, P5-3).',
    type: 'record', default: null, source: 'record', record: 'apphost:install:<installationId> runAs', restartRequired: false, change: 'fresh',
    since: '2026-11-26', phase: '5 (P5-3)',
  },
  {
    id: 'app-root-execution',
    title: 'Root execution requests of apps',
    description: 'An app may REQUEST root in its manifest (`execution: { runAs: "root", reason }`). approve (default): you can '
      + 'approve a request at install or update with your password (the high-risk section of the dialog), or later with '
      + '`aura admin apps run-as <app> root`; the approval is bound to that installation and that exact config, and an update '
      + 'that introduces or expands it asks again. Approved root is runtime root only: no capability, no-new-privileges, no '
      + 'Docker socket, no host access. refuse: no root request runs; such an app is installed but does not start. Either way an '
      + 'app whose request is not approved does not start (never a silent escalation). Legacy root installations (before 5-apps) '
      + 'are not affected (owner decision 5-main item 3).',
    type: 'enum', values: ['approve', 'refuse'], default: 'approve', source: 'policy',
    restartRequired: false, change: 'fresh', since: '2026-11-26', phase: '5 (5-main, root requests)',
  },
  {
    id: PROOT_HOST,
    title: 'PRoot on this host',
    description: 'Whether the proot runtime can run apps at all. true (set in docker-compose): PRoot apps run wrapped in PRoot '
      + 'under their own app identity, with a narrowed view (no /workspace beyond the shared packages, no /run/context, no '
      + 'socket, their App Home, their own /tmp). Unset or false (default): the proot runtime is unavailable and a PRoot app '
      + 'start fails closed; PRoot never runs an app unwrapped in the AuraOS container (D75, D92).',
    type: 'boolean', default: false, source: 'env', env: 'AURA_USE_PROOT', restartRequired: true, change: 'fresh',
    since: '2026-11-26', phase: '5 (R2, D92)',
  },
  {
    id: 'runtime-install',
    title: 'Installable runtimes',
    description: 'Runtime modules beyond the built-in container and PRoot: a Nexus package of kind runtime, run out of '
      + 'process as a driver that speaks ARI, signed, installed and enabled by the owner at fresh. Not yet available: only '
      + 'the built-in runtimes exist, and a module whose ARI is newer than this AuraOS is refused (ARI §4.1-4.3, ARI-2).',
    type: 'enum', values: ['built-in-only'], default: 'built-in-only', source: 'reserved',
    restartRequired: false, change: 'fresh', since: '2026-11-26', phase: 'later (ARI §4.1)',
  },
  {
    id: 'aura-root',
    title: 'Root tab (`aura root`)',
    description: 'enabled (default): the owner can open a dedicated root tab (`aura root` in their own Terminal) with the '
      + 'Docker socket in that tab\'s session only, after a password approval, audited. disabled: `aura root` is refused '
      + '(a Zero Trust installation turns it off); a tab already open stays until it ends (`aura root end`).',
    type: 'enum', values: ['enabled', 'disabled'], default: 'enabled', source: 'policy',
    restartRequired: false, change: 'fresh', since: '2026-11-26', phase: '5 (D55, P5-4)',
  },
  {
    id: UPDATE_CHANNEL,
    title: 'Update channel',
    description: 'Where release updates come from. signed (default): signed release tags only; a missing, invalid or '
      + 'untrusted signature is refused, and an update never falls back to an unsigned revision. main: the unsigned '
      + 'development head; its releases are shown as unsigned and a security-update claim in them is ignored. Switching '
      + 'to main needs your password and is its own decision, never a side effect of an update. install.sh records the '
      + 'channel it installed from; release updates read this option (Phase 6, stream U).',
    type: 'enum', values: ['signed', 'main'], default: 'signed', source: 'policy',
    restartRequired: false, change: 'fresh', since: '2026-11-27', phase: '6 (D71, Stage 1b)',
  },
  {
    id: SECURITY_UPDATE_POLICY,
    title: 'Signed security updates',
    description: 'What a signed release flagged as a security update does. follow-signed (default): it is flagged in the '
      + 'update dialog and, with system patches (Phase 7), installed without a patch that no longer applies. hold: it is '
      + 'treated like any other update (your audited override). Only signed releases can flag a security update.',
    type: 'enum', values: ['follow-signed', 'hold'], default: 'follow-signed', source: 'policy',
    restartRequired: false, change: 'fresh', since: '2026-11-27', phase: '6 (D71, Stage 1b)',
  },
  {
    id: RELEASE_AUTO_UPDATE,
    title: 'Unattended release updates',
    description: 'Installing release updates without the owner. Not yet available: in the alpha every release update is '
      + 'started and approved by the owner.',
    type: 'enum', values: ['off'], default: 'off', source: 'reserved',
    restartRequired: false, change: 'fresh', since: '2026-11-27', phase: 'later (D71)',
  },
  {
    id: RELEASE_TRUSTED_KEYS,
    title: 'Trusted release keys',
    description: 'Release signing keys the host operator added beyond the keys the running release ships '
      + '(os/release-keys/): a replacement for a lost or compromised key, or an internal signer. Public keys only '
      + '(*.pub, revoked.txt) in /data/aura/release/trusted-keys/; every change needs your password or the host and is '
      + 'audited. A revoked key is never trusted again.',
    type: 'record', default: null, source: 'record', record: 'aura/release/trusted-keys', restartRequired: false,
    change: 'fresh', since: '2026-11-27', phase: '6 (D71, Stage 1b)',
  },
  {
    id: INFRA_PUBLIC_FALLBACK,
    title: 'Public fallback of the infrastructure config',
    description: 'Whether AuraOS may still reach public endpoints when an infrastructure configuration names internal '
      + 'mirrors (D94). allow (default): what the config does not cover goes to the public default. deny: AuraOS-run '
      + 'operations use only the configured endpoints; the default Nexus store index, a capability download from a public '
      + 'URL and the updater\'s compose download are refused with a diagnostic, and install.sh refuses a build input that '
      + 'would go public. Seeded once from the install config\'s policy block (host operator, audited).',
    type: 'enum', values: ['allow', 'deny'], default: 'allow', source: 'policy',
    restartRequired: false, change: 'fresh', since: '2026-11-27', phase: '6 (D94 IC-6)',
  },
  {
    id: INFRA_PROXY,
    title: 'Corporate proxy',
    description: 'off (default): no proxy policy. configured: a proxy is set in the infrastructure config and AuraOS, the '
      + 'builders and apps (without credentials) use it; the doctor reports a mismatch between this option and the config. '
      + 'enforced (beta, BT-I): network-level enforcement. Seeded once from the install config\'s policy block.',
    type: 'enum', values: ['off', 'configured'], default: 'off', source: 'policy',
    restartRequired: false, change: 'fresh', since: '2026-11-27', phase: '6 (D94 IC-6)',
  },
  {
    id: INFRA_INHERIT,
    title: 'Apps inherit the infrastructure defaults',
    description: 'defaults (default): every app and sidecar gets the non-secret infrastructure settings with no manifest '
      + 'change: the CA bundle, the proxy without credentials, NO_PROXY and the registry pointers (read-only under '
      + '/etc/aura/infra). none: apps get nothing (an app then reaches the network as without a config). Credentials never '
      + 'reach an app either way (O4). Applies at an instance\'s next start.',
    type: 'enum', values: ['defaults', 'none'], default: 'defaults', source: 'policy',
    restartRequired: false, change: 'fresh', since: '2026-11-27', phase: '6 (D94 IC-6)',
  },
  {
    id: INFRA_PUBLIC_ROOTS,
    title: 'Public certificate roots',
    description: 'keep (default): the corporate CAs are added to the public roots. replace: only the corporate CAs are '
      + 'trusted; the infrastructure config must say trust.publicRoots: replace as well (both are needed: an explicit '
      + 'choice, never a side effect of a config apply). A mismatch is reported by the doctor and the boot status.',
    type: 'enum', values: ['keep', 'replace'], default: 'keep', source: 'policy',
    restartRequired: true, change: 'fresh', since: '2026-11-27', phase: '6 (D94 IC-6)',
  },
  {
    id: INFRA_CREDENTIAL_GRANTS,
    title: 'Infrastructure credentials for apps',
    description: 'Granting an app or a user an infrastructure credential (proxy, registry, client certificate). Not yet '
      + 'available: in the alpha only the installer, the system builders and the updater use them; apps never do.',
    type: 'enum', values: ['none'], default: 'none', source: 'reserved',
    restartRequired: false, change: 'fresh', since: '2026-11-27', phase: 'beta (BT-I)',
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
  /** `default`, `policy`, `env AURA_X`, `record user:policy:…`, `file /data/aura/…` or `reserved`. */
  effectiveSource: string;
  writable: boolean;
  /** An env value that is not one of `values`: the default applies (its read point logs it). */
  invalidEnv?: true;
}

/** A `file` option's switch file, or null when it is missing or unreadable. */
export type SecurityOptionFileReader = (file: string) => string | null;

const readDataFile: SecurityOptionFileReader = (file) => {
  try { return readFileSync(join(process.env['AURA_DATA_DIR'] ?? '/data', file), 'utf8'); } catch { return null; }
};

/**
 * Every option's effective value and where it comes from. A host variable
 * wins; then the policy record or the switch file; then the default.
 */
export function resolveSecurityOptions(
  policy: SecurityPolicy,
  env: Record<string, string | undefined> = process.env,
  readFile: SecurityOptionFileReader = readDataFile,
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
    if (o.source === 'file' && o.file) {
      const v = (readFile(o.file) ?? '').trim();
      if (o.values?.includes(v)) return { ...o, value: v, effectiveSource: `file /data/${o.file}`, writable };
    }
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
