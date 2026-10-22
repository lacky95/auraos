import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { defaultAdminKeyFile, readAdminCredential, rotateAdminCredential } from '@aura/core';
import { api, shellUrl } from '../lib/client.js';
import { buildSystemDecisionPayload, describeDecision } from '../lib/system-decision.js';
import { color, fail, info, ok, table, warn } from '../lib/format.js';
import { promptConfirm } from '../lib/prompts.js';
import {
  ADMIN_SESSION_FILE, adminHeaders, adminLogin, clearSavedSession, currentAdminSession, forgetInProcessSession,
  obtainCredential, saveSession, savedSession,
} from '../lib/admin-session.js';

/**
 * `aura admin …` — minimal admin authentication (ONE shared operator
 * credential, no user accounts) plus the admin-only management commands.
 *
 * Every change is audited by the shell as "admin (shared credential)".
 */

const FEATURES: Record<string, string> = {
  locked: 'notifications.locked',
  popup: 'notifications.popup',
  read: 'notifications.read',
  'notifications.locked': 'notifications.locked',
  'notifications.popup': 'notifications.popup',
  'notifications.read': 'notifications.read',
};

export function notifPermission(name: string): string {
  const p = FEATURES[name];
  if (!p) fail(`unknown notification permission '${name}' — use locked | popup | read`);
  return p!;
}

/** `read` grants (phase 5): which senders, and whether secret items count. */
export interface ReadGrantOpts {
  scope?: string;
  includeSecret?: boolean;
}

interface GrantsDto {
  privileged: string[];
  apps: Array<{ appId: string; name?: string; scope: string | null; sends: boolean; requested: string[]; granted: string[]; effective: string[]; read?: { label: string } }>;
  grants: Array<{ subject: { kind: string; id: string }; permission: string; appScope?: string; grantedAt: number }>;
}

export async function fetchNotifPerms(): Promise<GrantsDto> {
  return api.get<GrantsDto>('/api/admin/grants');
}

export async function grantNotif(verb: 'grant' | 'revoke', appId: string, features: string[], readOpts: ReadGrantOpts = {}): Promise<void> {
  if (features.length === 0) fail(`aura ${verb} notif-perms <app> <locked|popup|read...>`);
  for (const f of features) {
    const permission = notifPermission(f);
    if (verb === 'grant') {
      const isRead = permission === 'notifications.read';
      if (isRead && !readOpts.scope) {
        fail('read needs --scope: app:<appId>, sender:<senderKey> (comma-separated) or all — e.g. aura grant nperm com.example.x read --scope app:com.example.y');
      }
      if (!isRead && (readOpts.scope || readOpts.includeSecret)) warn(`--scope / --include-secret only apply to read (ignored for ${f})`);
      const r = await api.post<{ changed: boolean; warnings?: string[]; record: { appScope?: string; read?: { includeSecret: boolean } } }>(
        '/api/admin/grants', {
          subjectKind: 'app', subjectId: appId, permission,
          ...(isRead ? { readScope: readOpts.scope, includeSecret: readOpts.includeSecret === true } : {}),
        });
      const what = isRead ? ` (read ${readOpts.scope}${readOpts.includeSecret ? ', secret included' : ''})` : '';
      if (r.changed) ok(`granted ${color.bold(permission)} to ${color.bold(appId)}${what}${r.record.appScope ? color.dim(` (scope ${r.record.appScope})`) : ''}`);
      else info(`${appId} already has ${permission}`);
      for (const w of r.warnings ?? []) warn(w);
    } else {
      const r = await api.del<{ changed: boolean }>(
        `/api/admin/grants?subjectKind=app&subjectId=${encodeURIComponent(appId)}&permission=${encodeURIComponent(permission)}`);
      if (r.changed) ok(`revoked ${color.bold(permission)} from ${color.bold(appId)}`);
      else info(`${appId} had no grant of ${permission}`);
    }
  }
}

function inMaster(): boolean {
  return existsSync(defaultAdminKeyFile());
}

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export function registerAdmin(program: Command): void {
  const admin = program
    .command('admin')
    .description('Admin authentication (shared operator credential) and admin-only management: grants, API keys, audit.');

  admin
    .command('login')
    .description('Unlock admin: exchange the shared credential for a 15-minute session (AURA_ADMIN_CREDENTIAL, the master key file, or a hidden prompt).')
    .option('--save', `keep the session in ${ADMIN_SESSION_FILE} (0600) for its 15 minutes`)
    .option('--print', 'print the session token (for `export AURA_ADMIN_SESSION=…`)')
    .action(async (opts: { save?: boolean; print?: boolean }) => {
      const credential = await obtainCredential(true);
      if (!credential) fail('no credential: set AURA_ADMIN_CREDENTIAL or run this on a TTY. The credential is in the master container — `aura jump -m`, then `aura admin credential`.');
      const s = await adminLogin(credential!).catch((err: Error) => fail(err.message));
      if (opts.print) {
        process.stdout.write(`${s.token}\n`);
        return;
      }
      if (opts.save) {
        saveSession(s);
        ok(`admin unlocked until ${fmtTime(s.expiresAt)} — saved to ${ADMIN_SESSION_FILE}`);
        warn('~ is shared by every app: any app sandbox can read this file while it is valid. `aura admin logout` removes it.');
      } else {
        ok(`credential accepted — session valid until ${fmtTime(s.expiresAt)}, but NOT kept (this command only).`);
        info('Use --save to keep it for 15 minutes, or --print to export it. Admin commands also ask for the credential when needed.');
      }
    });

  admin
    .command('logout')
    .description('Lock admin: revoke the saved / exported session and delete the session file.')
    .action(async () => {
      const token = currentAdminSession();
      if (token) {
        const res = await fetch(`${shellUrl()}/api/admin/session`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
          .catch(() => null);
        if (res?.ok) ok('admin session revoked');
        else info('session was already invalid or expired');
      } else {
        info('no admin session');
      }
      forgetInProcessSession();
      if (clearSavedSession()) ok(`removed ${ADMIN_SESSION_FILE}`);
      if (process.env['AURA_ADMIN_SESSION']) warn('AURA_ADMIN_SESSION is still set in this shell — `unset AURA_ADMIN_SESSION`.');
    });

  admin
    .command('status')
    .description('Is an admin session available, and until when?')
    .action(async () => {
      const token = currentAdminSession();
      if (!token) { info('locked — no admin session (aura admin login --save)'); return; }
      const res = await fetch(`${shellUrl()}/api/admin/session`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
      if (!res?.ok) { info('locked — the session is invalid or expired'); return; }
      const body = await res.json() as { expiresAt?: number };
      const saved = savedSession();
      ok(`unlocked as ${color.bold('admin (shared credential)')} until ${body.expiresAt ? fmtTime(body.expiresAt) : '?'}${saved ? color.dim(` · saved in ${ADMIN_SESSION_FILE}`) : ''}`);
    });

  admin
    .command('credential')
    .description('Print the shared admin credential (master container only: `aura jump -m` first).')
    .action(() => {
      const f = defaultAdminKeyFile();
      const c = inMaster() ? readAdminCredential(f) : null;
      if (!c) fail(`no readable credential at ${f} — this works only in the master container (aura jump -m).`);
      process.stdout.write(`${c}\n`);
    });

  admin
    .command('rotate')
    .description('Replace the shared admin credential (master container only). Every admin session ends at once.')
    .option('-y, --yes', 'do not ask')
    .action(async (opts: { yes?: boolean }) => {
      const f = defaultAdminKeyFile();
      if (!inMaster()) fail(`${f} is not here — rotate in the master container (aura jump -m).`);
      if (!opts.yes) {
        const yes = await promptConfirm('Rotate the admin credential? Every admin session (CLI and Settings) ends now.', false);
        if (yes !== true) { info('aborted'); return; }
      }
      const fresh = rotateAdminCredential(f);
      clearSavedSession();
      ok(`rotated — new credential (shown once; also readable with \`aura admin credential\`):`);
      process.stdout.write(`${fresh}\n`);
      info('The shell notices the new key file on its next admin check and revokes all sessions (audited as credential.rotated).');
    });

  admin
    .command('grants')
    .description('Privileged notification permissions per app: requested (manifest) vs granted (admin) vs effective.')
    .action(async () => {
      const d = await fetchNotifPerms();
      if (d.apps.length === 0) { info('no app sends or requests notification permissions'); return; }
      console.log(table(d.apps.map((a) => ({
        APP: a.appId,
        SCOPE: a.scope ?? '-',
        SENDS: a.sends ? 'yes' : color.dim('no'),
        REQUESTED: a.requested.map((p) => p.replace('notifications.', '')).join(',') || color.dim('-'),
        GRANTED: a.granted.map((p) => p.replace('notifications.', '')).join(',') || color.dim('-'),
        EFFECTIVE: a.effective.map((p) => p.replace('notifications.', '')).join(',') || color.dim('-'),
        READS: a.read?.label ?? color.dim('-'),
      }))));
    });

  admin
    .command('grant <app> <features...>')
    .description("Grant privileged notification features (locked | popup | read) to an app. The app must also request them in its manifest. read = other senders' notifications, scoped with --scope.")
    .option('--scope <scope>', 'read: app:<appId>, sender:<senderKey> (comma-separated) or all')
    .option('--include-secret', 'read: secret notifications too (default: not)')
    .action((app: string, features: string[], opts: { scope?: string; includeSecret?: boolean }) => grantNotif('grant', app, features, opts));

  admin
    .command('revoke <app> <features...>')
    .description('Revoke privileged notification features (locked | popup | read). Takes effect at once.')
    .action((app: string, features: string[]) => grantNotif('revoke', app, features));

  registerAdminDev(admin);

  admin
    .command('audit')
    .description('The admin audit trail, newest first.')
    .option('-n, --limit <n>', 'entries', '30')
    .action(async (opts: { limit: string }) => {
      const { entries } = await api.get<{ entries: Array<{ at: number; actor: string; action: string; target?: string; outcome: string; detail?: unknown }> }>(
        `/api/admin/audit?limit=${encodeURIComponent(opts.limit)}`);
      if (entries.length === 0) { info('no audit entries'); return; }
      console.log(table(entries.map((e) => ({
        TIME: fmtTime(e.at),
        ACTOR: e.actor,
        ACTION: e.action,
        TARGET: e.target ?? '-',
        OUTCOME: e.outcome === 'ok' ? e.outcome : color.yellow(e.outcome),
        DETAIL: e.detail ? JSON.stringify(e.detail) : '',
      }))));
    });
}

// ─── aura admin dev … (DEV-only test hooks) ─────────────────────────────────

export function registerAdminDev(admin: Command): void {
  const dev = admin
    .command('dev')
    .description('DEV-only test hooks (dev shell only, admin session, audited).');
  dev
    .command('system-decision')
    .description('Show an AuraOS system decision: a desktop-wide modal (scope desktop) that BLOCKS THE WHOLE DESKTOP until answered. Dev shell only; created as AuraOS, audited as dev.systemDecision.')
    .option('--title <t>', 'title')
    .option('--text <x>', 'text')
    .option('--priority <p>', 'low | medium | high (default) | urgent')
    .option('--inputs [labels]', 'add inputs: comma-separated labels (default: one "Reason")')
    .option('--options [labels]', 'add a choice: comma-separated labels (default: Allow, Deny, Ask me later); > 4 → a radio list')
    .option('--cancel-label <l>', 'text of the Cancel button')
    .option('--submit-label <l>', 'text of the Submit button')
    .option('--json <payload>', 'a full notification input as JSON (the flags above override it); type / scope are forced')
    .option('--wait [seconds]', 'wait for the answer and print it (default 300 s)')
    .option('-o, --output <fmt>', 'json: print the raw responses')
    .action(async (opts: {
      title?: string; text?: string; priority?: string; inputs?: boolean | string; options?: boolean | string;
      cancelLabel?: string; submitLabel?: string; json?: string; wait?: boolean | string; output?: string;
    }) => {
      let payload: Record<string, unknown>;
      try { payload = buildSystemDecisionPayload(opts); } catch (err) { fail((err as Error).message); return; }
      let r: { notification: { id: string; title: string }; warnings?: Array<{ message: string }> };
      try {
        r = await api.post('/api/admin/dev/system-decision', { payload });
      } catch (err) {
        const e = err as Error & { status?: number };
        if (e.status === 404 || /404/.test(e.message)) {
          fail('refused: the system-decision hook exists only on the DEV shell (astro dev). Production shells have no way to create a desktop decision from outside AuraOS.');
        }
        fail(e.message);
        return;
      }
      if (opts.output === 'json') console.log(JSON.stringify(r, null, 2));
      else {
        ok(`system decision ${color.bold(r.notification.id)} "${r.notification.title}" — it blocks the desktop until answered`);
        for (const w of r.warnings ?? []) warn(w.message);
      }
      process.stdout.write(`${r.notification.id}\n`);
      if (opts.wait === undefined || opts.wait === false) return;
      const total = opts.wait === true ? 300 : Number(opts.wait);
      if (!Number.isFinite(total) || total <= 0) fail('--wait takes a number of seconds');
      const deadline = Date.now() + total * 1000;
      info(`waiting up to ${total} s for the answer…`);
      for (;;) {
        const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        const t = Math.min(25, left);
        // The admin session reads every notification (GET is not an /api/admin route, so attach it here).
        const res = await fetch(`${shellUrl()}/api/notifications/${encodeURIComponent(r.notification.id)}?waitFor=resolved&timeout=${t}`, { headers: adminHeaders() })
          .catch((err: Error) => fail(`cannot reach the shell: ${err.message}`));
        const n = await (res as Response).json() as { state: string; outcome?: string; answer?: unknown; removedReason?: string; error?: string };
        if (!(res as Response).ok) fail(`waiting failed: ${(res as Response).status} ${n.error ?? ''}`);
        if (n.state !== 'active') {
          if (opts.output === 'json') console.log(JSON.stringify(n, null, 2));
          ok(`answer: ${describeDecision(n)}`);
          return;
        }
        if (Date.now() >= deadline) { warn(`still pending after ${total} s (${r.notification.id})`); return; }
      }
    });
}

// ─── aura apikey ────────────────────────────────────────────────────────────

const SCOPE_ALIASES: Record<string, string> = {
  send: 'system.notifications', notifications: 'system.notifications', 'system.notifications': 'system.notifications',
  locked: 'notifications.locked', 'notifications.locked': 'notifications.locked',
  popup: 'notifications.popup', 'notifications.popup': 'notifications.popup',
};

export function registerApiKey(program: Command): void {
  const key = program
    .command('apikey')
    .description('API keys for external REST callers (admin only). A key authenticates as `Authorization: Bearer aura_k1_…`.');

  key
    .command('create <name>')
    .description('Create a key. The secret is shown ONCE. Scopes: send (default), locked, popup.')
    .option('-s, --scope <scope...>', 'send | locked | popup (repeatable)', ['send'])
    .action(async (name: string, opts: { scope: string[] }) => {
      const scopes = [...new Set(opts.scope.map((s) => {
        const v = SCOPE_ALIASES[s];
        if (!v) fail(`unknown scope '${s}' — use send | locked | popup`);
        return v!;
      }))];
      const r = await api.post<{ key: string; apiKey: { id: string; name: string; scopes: string[] } }>('/api/admin/api-keys', { name, scopes });
      ok(`created API key ${color.bold(r.apiKey.id)} (${r.apiKey.name}) — scopes ${r.apiKey.scopes.join(', ')}`);
      warn('The key is shown only now. Store it somewhere safe:');
      process.stdout.write(`${r.key}\n`);
    });

  key
    .command('ls')
    .alias('list')
    .description('List keys (never secrets).')
    .action(async () => {
      const { keys } = await api.get<{ keys: Array<{ id: string; name: string; scopes: string[]; createdAt: number; lastUsedAt?: number; revokedAt?: number }> }>('/api/admin/api-keys');
      if (keys.length === 0) { info('no API keys'); return; }
      console.log(table(keys.map((k) => ({
        ID: k.id,
        NAME: k.name,
        SCOPES: k.scopes.join(','),
        CREATED: fmtTime(k.createdAt),
        'LAST-USED': k.lastUsedAt ? fmtTime(k.lastUsedAt) : color.dim('never'),
        STATE: k.revokedAt ? color.dim('revoked') : color.green('active'),
      }))));
    });

  key
    .command('revoke <id>')
    .description('Revoke a key: it gets 401 at once.')
    .action(async (id: string) => {
      const r = await api.del<{ apiKey: { id: string; name: string } }>(`/api/admin/api-keys?id=${encodeURIComponent(id)}`);
      ok(`revoked API key ${color.bold(r.apiKey.id)} (${r.apiKey.name})`);
    });
}
