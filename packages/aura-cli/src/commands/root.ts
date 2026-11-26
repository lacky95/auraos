/**
 * `aura root`: the dedicated root tab (Phase 5 stream J.6, P5-4, D55).
 *
 *   aura root               in your System Terminal: ask (password approval in
 *                           the desktop, or `aura approve` on the host), then a
 *                           root session in THIS Terminal instance with the
 *                           Docker socket in that session only; `exit` ends it
 *   aura root -- <cmd…>     the same root session for one command, without a TTY
 *   aura root ls            the open root tabs
 *   aura root end [inst]    End them (one Terminal instance, or all)
 *
 * Normal tabs stay at your uid with no socket. The root session never
 * survives a Terminal or kernel restart. The owner can turn the whole
 * feature off with the security option `aura-root`.
 */
import type { Command } from 'commander';
import { env as procEnv, stdin, stdout } from 'node:process';
import { api } from '../lib/client.js';
import { color, fail, info, ok, warn } from '../lib/format.js';
import { runSession } from '../lib/exec-client.js';
import { callerHostLabel, setTerminalHost } from '../lib/enter-sandbox.js';

interface RootTabDto { sessionId: string; instanceId: string; userId: string | null; startedAt: string }

export function registerRoot(program: Command): void {
  const root = program
    .command('root [cmd...]')
    .summary('Open a root tab with the Docker socket in your Terminal (password approval).')
    .description('Open a dedicated root session in your own System Terminal: root with Docker\'s default capabilities, your home, and the Docker socket in that session only. Needs your approval with the password (or `aura approve` on the host). `exit` ends it.')
    .action(async (cmd: string[]) => {
      const instanceId = procEnv['APP_INSTANCE_ID'];
      if (!instanceId || procEnv['APP_ID'] !== 'com.aura.terminal') fail('aura root runs in your System Terminal (it opens a root tab in that Terminal)');
      if (procEnv['AURA_ROOT_SESSION'] === '1') fail('this already is a root tab');
      const oneShot = cmd.length > 0;
      if (!oneShot && (!stdin.isTTY || !stdout.isTTY)) fail('aura root needs a TTY (or a command: aura root -- <cmd…>)');
      const r = await api.post<{ grant?: string; error?: string; message?: string }>('/api/admin/root', { instanceId });
      if (!r.grant) fail(`aura root: ${r.message ?? r.error ?? 'refused'}`);
      if (oneShot) {
        const s = await runSession({ instanceId, kind: 'exec', tty: false, argv: cmd, home: 'private', root: r.grant! });
        if (!s.opened) fail(`root session refused: ${s.reason}`);
        process.exit(s.code ?? 1);
      }
      warn(`${color.bold('ROOT TAB')}: root in ${instanceId} with the Docker socket (full control of the host). \`exit\` ends it.`);
      const restore = callerHostLabel();
      setTerminalHost(`ROOT ${instanceId}`);
      const s = await runSession({ instanceId, kind: 'jump', tty: true, home: 'private', root: r.grant! });
      setTerminalHost(restore);
      if (!s.opened) fail(`root session refused: ${s.reason}`);
      ok(`root tab ended (code ${s.code ?? 1})`);
      process.exit(s.code ?? 1);
    });

  root
    .command('ls')
    .description('The open root tabs.')
    .action(async () => {
      const r = await api.get<{ enabled: boolean; tabs: RootTabDto[] }>('/api/admin/root');
      if (!r.enabled) info('aura root is disabled (security option aura-root)');
      if (!r.tabs.length) { info('no root tab is open'); return; }
      for (const t of r.tabs) console.log(`${t.instanceId}\t${t.userId ?? '-'}\t${t.startedAt}\t${color.dim(t.sessionId)}`);
    });

  root
    .command('end [instance]')
    .description('End the root tabs of a Terminal instance (all without one).')
    .action(async (instance: string | undefined) => {
      const q = instance ? `?instanceId=${encodeURIComponent(instance)}` : '';
      const r = await api.del<{ ended: string[] }>(`/api/admin/root${q}`);
      ok(r.ended.length ? `ended ${r.ended.length} root tab(s)` : 'no root tab was open');
    });
}
