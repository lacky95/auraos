import type { Command } from 'commander';
import { api } from '../lib/client.js';
import { color, fail } from '../lib/format.js';

interface ShellModeState { running: 'dev' | 'prod'; configured: 'dev' | 'prod' | null; env: string | null }

/**
 * `aura shell mode [dev|prod]` — how the shell runs: `dev` (astro dev with
 * hot reload, for working on the shell) or `prod` (the production build,
 * faster). Written to the persistent switch the boot reads; applies after
 * `aura restart os`. Docs: deep-dive/shell-runtime-modes.
 */
export function registerShellMode(program: Command): void {
  const shell = program
    .command('shell')
    .description('The AuraOS shell itself (runtime mode).');
  shell
    .command('mode [mode]')
    .description('Show or set how the shell runs: dev (hot reload) or prod (production build). Applies after `aura restart os`.')
    .addHelpText('after', [
      '',
      'Examples:',
      '  aura shell mode            # running vs configured mode',
      '  aura shell mode prod       # use the production build from the next restart',
      '  aura restart os            # restart now (your desktop comes back)',
    ].join('\n'))
    .action(async (mode: string | undefined) => {
      try {
        if (mode === undefined) {
          const s = await api.get<ShellModeState>('/api/admin/shell-mode');
          const next = s.env === 'dev' || s.env === 'prod' ? s.env : (s.configured ?? 'dev');
          console.log(`running:    ${color.green(s.running)}`);
          console.log(`next boot:  ${next}${s.env ? color.dim(' (AURA_SHELL_MODE on the container)') : s.configured ? '' : color.dim(' (default)')}`);
          return;
        }
        if (mode !== 'dev' && mode !== 'prod') fail(`mode must be dev or prod (got '${mode}')`);
        const s = await api.put<ShellModeState & { ok: boolean }>('/api/admin/shell-mode', { mode });
        console.log(`${color.green('✓')} shell mode ${mode} from the next boot (running: ${s.running}).`);
        if (s.env && s.env !== mode) console.log(color.dim(`  Note: AURA_SHELL_MODE=${s.env} on the container wins over this setting.`));
        else if (s.running !== mode) console.log(color.dim('  Apply now: aura restart os'));
      } catch (err) {
        fail(`shell mode: ${(err as Error).message}`);
      }
    });
}
