/**
 * Who the CLI is on a request, and the one fetch that may carry that identity.
 *
 * Rules:
 *   - An instance token goes only to the origin of the runner-injected
 *     OS_API_BASE or AURA_OS_URL.
 *   - An operator ticket goes only to the trusted shell: the runner origin, or
 *     the loopback default when no runner origin exists.
 *   - Nothing is attached to /api/proxy/*: the proxy forwards it to the app
 *     (MCP and other proxied calls stay tokenless, D28). A credentialed
 *     request never follows a redirect.
 *
 * Authorization (5.8, D13, D50): inside a sandbox every call carries this
 * process's instance token (`self`), event streams included, so the shell
 * sees the instance and the user it acts for. What the owner decides (grants,
 * API keys, the audit trail, manifest edits, installs) answers 202
 * needs-approval there, and the CLI waits for the owner's approval in the
 * desktop (lib/client.ts). On the host (`docker exec aura-shell aura …`) a
 * call with no other credential carries a one-time operator ticket for
 * exactly that request (`X-Aura-Operator`), and the operator acts directly.
 * There is no shared admin credential: no `aura admin login`, no
 * AURA_ADMIN_*, no ~/.aura/admin-session. A per-device login token for a
 * remote CLI comes later.
 */
// The file-only entry: the package root would bundle Valkey and the server runtime.
import { createSetupTicket, operatorRequestSubject } from '@aura/core/setup-tickets';
import { DEFAULT_SHELL_URL, shellUrl } from './shell-url.js';

export type IdentityIntent =
  | 'anonymous'
  | 'self'                  // this process's own instance token, if it may go to this URL
  | 'instance'              // this process's own instance (needs instanceId)
  | 'whoami'                // the best identity to ask the server about
  | 'credential-exchange';  // the body holds a credential: no header, no redirects

export interface IdentityRequest {
  url: string;
  path: string;
  intent: IdentityIntent;
  instanceId?: string;
}

export type IdentitySource = 'none' | 'instance-token' | 'operator-ticket';

export interface ResolvedIdentity {
  kind: 'none' | 'instance' | 'operator';
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

/** Is this the shell of this system (may an operator ticket go here)? */
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

function none(trusted: boolean, credentialed = false): ResolvedIdentity {
  return { kind: 'none', source: 'none', headers: {}, credentialed, trusted };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** This process's instance token for `target`; with `instanceId`, only when that is this instance. */
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
    case 'self':     return instanceIdentity(target, trusted) ?? none(trusted);
    case 'instance': return instanceIdentity(target, trusted, instanceId ?? '') ?? none(trusted);
    case 'whoami':   return instanceIdentity(target, trusted) ?? none(trusted);
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

/**
 * The host operator (plan 5.8): `aura` in the master container, outside any
 * sandbox, talking to its own shell. The ticket names this request's method
 * and path and is used up by the shell; only a process that can write the
 * master's secrets directory can create one. Null when that fails.
 */
function operatorIdentity(target: string, method: string): ResolvedIdentity | null {
  if (inSandbox() || !isTrustedShellUrl(target)) return null;
  try {
    const { code } = createSetupTicket(process.env['AURA_DATA_DIR'] ?? '/data', {
      purpose: 'operator', subject: operatorRequestSubject(method, new URL(target).pathname),
    });
    return { kind: 'operator', source: 'operator-ticket', headers: { 'X-Aura-Operator': code }, credentialed: true, trusted: true };
  } catch {
    return null;
  }
}

/**
 * The identity a request to `path` on the shell carries: this process's own
 * token if it may go there, else (on the host) a one-time operator ticket.
 * shellFetch and the exec bridge's WebSocket (lib/exec-client.ts) use it.
 */
export function shellIdentity(path: string, method = 'GET', intent: IdentityIntent = 'self', instanceId?: string): ResolvedIdentity {
  const url = shellUrl();
  const identity = resolveIdentity({ url, path, intent, ...(instanceId !== undefined ? { instanceId } : {}) });
  // Nothing else to send, and a call that may carry an identity: the host operator, if this is the host.
  if (identity.kind === 'none' && !identity.credentialed && intent !== 'anonymous' && !isProxyPath(`${url}${path}`)) {
    return operatorIdentity(`${url}${path}`, method) ?? identity;
  }
  return identity;
}

/** The CLI's only route to the shell API. It carries this process's identity unless told otherwise. */
export function shellFetch(path: string, init: ShellFetchInit = {}): Promise<Response> {
  const { intent = 'self', instanceId, headers, ...rest } = init;
  const url = shellUrl();
  const identity = shellIdentity(path, rest.method ?? 'GET', intent, instanceId);
  return fetch(`${url}${path}`, {
    ...rest,
    headers: { ...(headers as Record<string, string> | undefined), ...identity.headers },
    ...(identity.credentialed ? { redirect: 'error' as const } : {}),
  });
}
