/**
 * `aura admin user …` (Phase 5 stream I.2 part 2; D82, D83 §6): minimal
 * host-side provisioning of member accounts. Host only: each command refuses
 * in a sandbox, and the shell's routes take only the host operator's one-time
 * ticket (never the desktop, an app or an approval). No UI, invitations,
 * RBAC or IdP.
 *
 *   aura admin user add <username>                  a member; prints its one-time enrolment code
 *   aura admin user ls                              id, username, role, status, uid, created, grants
 *   aura admin user disable|enable <user>           sign-out everywhere and its sessions end / sign-in again; nothing is deleted
 *   aura admin user reset-password <user>           a one-time reset code bound to that account
 *   aura admin user grant|revoke <user> use|jump <app>
 *                                                   app.use (open and start its own instance) / app.jump (jump into it)
 *
 * The member types the code and a password on the shell's reset page
 * (`/setup` once the owner exists): no password ever appears on a command
 * line. `<user>` is a user id or a username.
 */
import type { Command } from 'commander';
import { api } from '../lib/client.js';
import { color, fail, info, ok, table, warn } from '../lib/format.js';
import { inSandbox } from '../lib/identity.js';
import { issueSetupCode, SetupCodeRefused } from '../lib/setup-ticket.js';

const HOST_ONLY = 'this is a host command. Run it from the host: docker exec -it aura-shell aura admin user …';

interface UserRow { id: string; username: string; role: string; status: string; uid: number | null; gid: number | null; createdAt: number; grants: string[] }

function hostOnly(): void {
  if (inSandbox()) fail(HOST_ONLY);
}

async function call<T>(method: 'get' | 'post', path: string, body?: unknown): Promise<T> {
  try {
    return method === 'get' ? await api.get<T>(path) : await api.post<T>(path, body);
  } catch (err) {
    const e = err as Error & { status?: number; body?: string };
    let message = e.message;
    try {
      const b = JSON.parse(e.body ?? '') as { error?: string; message?: string };
      if (b.message || b.error) message = b.message ?? b.error ?? message;
    } catch { /* not JSON */ }
    if (e.status === 404 && /^\/api\/admin\/users$/.test(path)) fail('this shell has no member accounts yet (Phase 5 isolation release).');
    fail(message);
  }
}

const userPath = (user: string) => `/api/admin/users/${encodeURIComponent(user)}`;

/** A one-time `reset` code bound to the account, made on the host (never by the shell). */
async function printEnrolmentCode(user: { id: string; username: string }, what: string): Promise<void> {
  let ticket: { code: string; expiresAt: number };
  try {
    ticket = await issueSetupCode({ purpose: 'reset', userId: user.id, username: user.username });
  } catch (err) {
    fail(err instanceof SetupCodeRefused ? err.message : 'could not create the code.');
    return;
  }
  process.stderr.write(`${what} for ${user.username}, valid until ${new Date(ticket.expiresAt).toISOString()}. It is shown only now.\n`
    + 'They open <AuraOS address>/setup and enter it with a new password (never on a command line):\n');
  process.stdout.write(`${ticket.code}\n`);
}

const fmt = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');

export function registerAdminUsers(admin: Command): void {
  const user = admin.command('user').description('Member accounts (D82, host only): add, list, disable, enable, reset a password, grant apps.');

  user
    .command('add <username>')
    .description('Host: create a member account (no password yet) and print its one-time enrolment code.')
    .option('--role <role>', 'member (the only role that can be created; there is one owner)', 'member')
    .action(async (username: string, opts: { role: string }) => {
      hostOnly();
      if (opts.role !== 'member') fail('--role owner is refused: there is exactly one owner. Members only.');
      const r = await call<{ user: { id: string; username: string; role: string }; created: boolean }>('post', '/api/admin/users', { username, role: 'member' });
      if (r.created) ok(`member ${r.user.username} created (${r.user.id})`);
      else warn(`${r.user.username} exists already (${r.user.id}); a new enrolment code replaces any earlier one`);
      info('It holds no app yet: aura admin user grant <user> use com.aura.terminal');
      await printEnrolmentCode(r.user, 'Enrolment code');
    });

  user
    .command('ls')
    .description('Host: every account by id, username, role, status, uid and grants (never a hash).')
    .option('-o, --output <format>', 'json')
    .action(async (opts: { output?: string }) => {
      hostOnly();
      const r = await call<{ users: UserRow[] }>('get', '/api/admin/users');
      if (opts.output === 'json') { console.log(JSON.stringify(r.users, null, 2)); return; }
      console.log(table(r.users.map((u) => ({
        ID: u.id, USERNAME: u.username, ROLE: u.role,
        STATUS: u.status === 'active' ? u.status : color.yellow(u.status),
        UID: u.uid ?? '-', CREATED: fmt(u.createdAt), GRANTS: u.grants.join(',') || color.dim('-'),
      }))));
    });

  for (const action of ['disable', 'enable'] as const) {
    user
      .command(`${action} <user>`)
      .description(action === 'disable'
        ? 'Host: refuse sign-in, sign the user out everywhere, end its Terminals and jump sessions. Nothing is deleted.'
        : 'Host: allow sign-in again, with the same id, uid, home and grants.')
      .action(async (ref: string) => {
        hostOnly();
        const r = await call<{ ok: boolean; user: { username: string; id: string }; changed: boolean; sessionsRevoked: number | null;
          ended?: { terminals: number; terminalsFailed: number; jumpSessions: number | null } | null }>('post', userPath(ref), { action });
        if (action === 'enable') {
          ok(`${r.user.username} (${r.user.id}) ${r.changed ? 'enabled' : 'was enabled already'}`);
          return;
        }
        ok(`${r.user.username} (${r.user.id}) ${r.changed ? 'disabled' : 'was disabled already'}`);
        info(`login sessions signed out: ${r.sessionsRevoked ?? 'unknown'}; Terminals stopped: ${r.ended?.terminals ?? 'unknown'}; `
          + `jump sessions ended: ${r.ended ? r.ended.jumpSessions ?? 'none (no session broker)' : 'unknown'}`);
      });
  }

  user
    .command('reset-password <user>')
    .description('Host: a one-time password reset code bound to that account (aura user reset-password takes a username).')
    .action(async (ref: string) => {
      hostOnly();
      const r = await call<{ users: UserRow[] }>('get', '/api/admin/users');
      const u = r.users.find((x) => x.id === ref || x.username === ref.trim().toLowerCase());
      if (!u) fail(`no account ${ref}`);
      if (u!.status !== 'active') warn(`${u!.username} is disabled: the code sets the password, sign-in waits for aura admin user enable`);
      await printEnrolmentCode(u!, 'Reset code');
    });

  for (const change of ['grant', 'revoke'] as const) {
    user
      .command(`${change} <user> <access> <app>`)
      .description(change === 'grant'
        ? 'Host: let a member use (open and start its own instance of) or jump into an app: access is use or jump.'
        : 'Host: take a member\'s use or jump grant on an app back.')
      .action(async (ref: string, access: string, appId: string) => {
        hostOnly();
        if (access !== 'use' && access !== 'jump') fail('access is use or jump');
        const r = await call<{ permission: string; changed: boolean; user: { username: string } }>('post', `${userPath(ref)}/grants`, { change, access, appId });
        ok(`${r.user.username}: ${change === 'grant' ? 'granted' : 'revoked'} ${r.permission}${r.changed ? '' : ' (no change)'}`);
      });
  }
}
