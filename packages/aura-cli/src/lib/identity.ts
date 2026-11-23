/**
 * Who the CLI is on a request, and the one fetch that may carry that identity.
 *
 * Rules (Phase 1, report-only):
 *   - An instance token goes only to the origin of the runner-injected
 *     OS_API_BASE or AURA_OS_URL.
 *   - Implicit admin credentials (saved session, master key file) go only to
 *     the trusted shell: the runner origin, or the loopback default when no
 *     runner origin exists. A 401 from any other URL never triggers them.
 *   - Explicit AURA_ADMIN_* still works everywhere, with a warning.
 *   - Nothing is attached to /api/proxy/*, and a credentialed request never
 *     follows a redirect.
 *
 * Ordinary API calls and event streams stay anonymous on purpose. The shell
 * answers 401 to an invalid bearer and treats an undeclared instance more
 * strictly than an anonymous caller, so attaching a token there could change
 * outcomes. Phase 3 decides that together with enforcement.
 */
import { DEFAULT_SHELL_URL, shellUrl } from './shell-url.js';
import { inProcessSession, savedSession } from './admin-session-store.js';

export type IdentityIntent =
  | 'anonymous'
  | 'admin'                 // an admin session, if one may go to this URL
  | 'instance'              // this process's own instance (needs instanceId)
  | 'whoami'                // the best identity to ask the server about
  | 'credential-exchange';  // the body holds a credential: no header, no redirects

export interface IdentityRequest {
  url: string;
  path: string;
  intent: IdentityIntent;
  instanceId?: string;
}

export type IdentitySource = 'none' | 'instance-token' | 'admin-env' | 'admin-process' | 'admin-saved';

export interface ResolvedIdentity {
  kind: 'none' | 'instance' | 'admin';
  source: IdentitySource;
  headers: Record<string, string>;
  /** The request carries a secret in a header or body: redirects are refused. */
  credentialed: boolean;
  /** The URL is the trusted shell. */
  trusted: boolean;
}

function httpOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

function runnerOrigins(): string[] {
  return [process.env['OS_API_BASE'], process.env['AURA_OS_URL']]
    .map(httpOrigin)
    .filter((o): o is string => o !== null);
}

/** The shell address the runner injected, ignoring AURA_SHELL_URL / --shell-url. */
export function runnerShellUrl(): string {
  return process.env['OS_API_BASE'] || process.env['AURA_OS_URL'] || DEFAULT_SHELL_URL;
}

/** May an instance token go here? */
export function isRunnerShellUrl(url: string): boolean {
  const origin = httpOrigin(url);
  return origin !== null && runnerOrigins().includes(origin);
}

/** May implicit admin credentials go here? */
export function isTrustedShellUrl(url: string): boolean {
  const origin = httpOrigin(url);
  if (origin === null) return false;
  const runner = runnerOrigins();
  return runner.length > 0 ? runner.includes(origin) : origin === httpOrigin(DEFAULT_SHELL_URL);
}

/** True for any spelling of /api/proxy. An unparsable path counts as proxied. */
export function isProxyPath(url: string): boolean {
  try {
    let path = url.startsWith('/') ? url.split(/[?#]/, 1)[0]! : new URL(url).pathname;
    for (let i = 0; i < 3; i++) {
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    }
    path = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    path = new URL(`http://shell${path.startsWith('/') ? '' : '/'}${path}`).pathname;
    return /^\/api\/proxy(\/|$)/i.test(path);
  } catch {
    return true;
  }
}

/** Running inside an app sandbox or sidecar (the master container has none of these). */
export function inSandbox(): boolean {
  return Boolean(process.env['APP_INSTANCE_ID'] || process.env['AURA_INSTANCE_ID'] || process.env['AURA_INSTANCE_TOKEN']);
}

const warned = new Set<string>();

export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  process.stderr.write(`warning: ${message}\n`);
}

/** Test hook. */
export function resetIdentityWarnings(): void {
  warned.clear();
}

/** Warn about an explicit AURA_ADMIN_* variable. Its value is never printed. */
export function warnExplicitAdmin(name: string, url: string): void {
  if (!isTrustedShellUrl(url)) {
    warnOnce(`untrusted:${name}`, `sending ${name} to ${httpOrigin(url) ?? 'an invalid URL'}, which is not this system's shell.`);
  }
  if (inSandbox()) {
    warnOnce(`sandbox:${name}`, `${name} is set inside an app sandbox, where other agents may read it. It stops working here in Phase 4.`);
  }
}

function none(trusted: boolean, credentialed = false): ResolvedIdentity {
  return { kind: 'none', source: 'none', headers: {}, credentialed, trusted };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

function adminIdentity(target: string, trusted: boolean): ResolvedIdentity {
  const pinned = process.env['AURA_ADMIN_SESSION']?.trim();
  if (pinned) {
    warnExplicitAdmin('AURA_ADMIN_SESSION', target);
    return { kind: 'admin', source: 'admin-env', headers: bearer(pinned), credentialed: true, trusted };
  }
  const own = inProcessSession(httpOrigin(target));
  if (own) return { kind: 'admin', source: 'admin-process', headers: bearer(own.token), credentialed: true, trusted };
  if (!trusted) return none(trusted);
  const saved = savedSession();
  return saved
    ? { kind: 'admin', source: 'admin-saved', headers: bearer(saved.token), credentialed: true, trusted }
    : none(trusted);
}

function instanceIdentity(target: string, trusted: boolean, instanceId?: string): ResolvedIdentity | null {
  const token = process.env['AURA_INSTANCE_TOKEN'];
  if (!token || !isRunnerShellUrl(target)) return null;
  if (instanceId !== undefined) {
    const self = process.env['APP_INSTANCE_ID'] ?? process.env['AURA_INSTANCE_ID'];
    if (self !== instanceId) return null;
  }
  return { kind: 'instance', source: 'instance-token', headers: bearer(token), credentialed: true, trusted };
}

export function resolveIdentity({ url, path, intent, instanceId }: IdentityRequest): ResolvedIdentity {
  const target = `${url}${path}`;
  const trusted = isTrustedShellUrl(target);
  if (intent === 'anonymous' || isProxyPath(target)) return none(trusted);
  switch (intent) {
    case 'credential-exchange': return none(trusted, true);
    case 'admin':    return adminIdentity(target, trusted);
    case 'instance': return instanceIdentity(target, trusted, instanceId ?? '') ?? none(trusted);
    case 'whoami':   return instanceIdentity(target, trusted) ?? adminIdentity(target, trusted);
  }
}

/** Does this process hold the token of that instance, for the current shell URL? */
export function holdsInstanceIdentity(instanceId: string): boolean {
  const path = `/api/instances/${encodeURIComponent(instanceId)}/sidecars`;
  return resolveIdentity({ url: shellUrl(), path, intent: 'instance', instanceId }).kind === 'instance';
}

export interface ShellFetchInit extends Omit<RequestInit, 'redirect'> {
  intent?: IdentityIntent;
  instanceId?: string;
}

/** The CLI's only route to the shell API. */
export function shellFetch(path: string, init: ShellFetchInit = {}): Promise<Response> {
  const { intent = 'anonymous', instanceId, headers, ...rest } = init;
  const url = shellUrl();
  const identity = resolveIdentity({ url, path, intent, ...(instanceId !== undefined ? { instanceId } : {}) });
  return fetch(`${url}${path}`, {
    ...rest,
    headers: { ...(headers as Record<string, string> | undefined), ...identity.headers },
    ...(identity.credentialed ? { redirect: 'error' as const } : {}),
  });
}
