/**
 * Who the smoke test is: the host operator when it runs in the master
 * container against its own shell, else anonymous.
 *
 * It uses the `aura` CLI's operator path (aura-cli lib/identity.ts,
 * `operatorIdentity`): one ticket per request, made with core's
 * `createSetupTicket` for `operatorRequestSubject(method, path)` and sent in
 * `X-Aura-Operator`. The shell uses it up when it checks the request. Only a
 * process that can write the master's secrets directory can make one.
 *
 * Tickets go only where the CLI sends them: never from inside a sandbox, and
 * only to the shell of this system (the runner origin, else the loopback
 * default). The shell never forwards the header to an app.
 */
import { normalizeTarget } from './http.mjs';

/** The CLI's loopback default (aura-cli lib/shell-url.ts DEFAULT_SHELL_URL). */
const DEFAULT_SHELL_ORIGIN = 'http://127.0.0.1:3000';
const TICKETS = new URL('../../../packages/core/dist/auth/setupTickets.js', import.meta.url);

const origin = (url) => {
  try { return normalizeTarget(new URL(url).origin); } catch { return null; }
};

/** Same rule as the CLI's `inSandbox()` and `isTrustedShellUrl()`. */
export function operatorAllowed(target, env = process.env) {
  if (env.APP_INSTANCE_ID || env.AURA_INSTANCE_ID || env.AURA_INSTANCE_TOKEN) return { ok: false, why: 'inside a sandbox' };
  const runner = [env.OS_API_BASE, env.AURA_OS_URL].map(origin).filter(Boolean);
  const trusted = runner.length ? runner : [DEFAULT_SHELL_ORIGIN];
  if (!trusted.includes(origin(target))) return { ok: false, why: 'the target is not this system\'s shell' };
  return { ok: true };
}

/**
 * `(method, path) => headers | null` for the client, or null with the reason.
 * `tickets` is core's setup-tickets module (loaded from the built core when omitted).
 */
export async function loadOperatorIdentity(target, { env = process.env, tickets } = {}) {
  const allowed = operatorAllowed(target, env);
  if (!allowed.ok) return { identity: null, why: allowed.why };
  let mod = tickets;
  if (!mod) {
    try { mod = await import(TICKETS.href); }
    catch { return { identity: null, why: 'packages/core is not built' }; }
  }
  const dataDir = env.AURA_DATA_DIR ?? '/data';
  const identity = (method, path) => {
    try {
      const { code } = mod.createSetupTicket(dataDir, {
        purpose: 'operator', subject: mod.operatorRequestSubject(method, path.split('?')[0]),
      });
      return { 'X-Aura-Operator': code };
    } catch {
      return null;
    }
  };
  return { identity, why: 'host operator' };
}
