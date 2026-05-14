import { Command } from 'commander';
import { registerApp } from './commands/app.js';
import { registerInst } from './commands/inst.js';
import { registerActivity } from './commands/activity.js';
import { registerPs } from './commands/ps.js';
import { registerStatus } from './commands/status.js';
import { registerCap } from './commands/cap.js';
import { registerService } from './commands/service.js';
import { registerDev } from './commands/dev.js';
import { registerTheme } from './commands/theme.js';
import { registerData } from './commands/data.js';
import { registerEvents } from './commands/events.js';
import { registerWhereami } from './commands/whereami.js';

const program = new Command();

program
  .name('aura')
  .description('AuraOS control CLI — manage apps, capabilities, services, and OS state from the shell.')
  .version('0.1.0')
  .option('--shell-url <url>', 'Override AuraOS shell URL (default: http://localhost:3000)')
  .hook('preAction', (thisCmd) => {
    const url = thisCmd.opts()['shellUrl'];
    if (typeof url === 'string') process.env['AURA_SHELL_URL'] = url;
  });

registerPs(program);
registerStatus(program);
registerApp(program);
registerInst(program);
registerActivity(program);
registerCap(program);
registerService(program);
registerDev(program);
registerTheme(program);
registerData(program);
registerEvents(program);
registerWhereami(program);

program
  .command('completion <shell>')
  .description('Print shell completion script (bash | zsh).')
  .action((shell: string) => {
    const subcommands = program.commands.map((c) => c.name()).filter((n) => n !== 'completion').join(' ');
    if (shell === 'bash') {
      process.stdout.write(`_aura_completions() {
  COMPREPLY=( $(compgen -W "${subcommands}" -- "\${COMP_WORDS[COMP_CWORD]}") )
}
complete -F _aura_completions aura
`);
    } else if (shell === 'zsh') {
      process.stdout.write(`#compdef aura
_aura() { compadd ${subcommands} }
_aura
`);
    } else {
      console.error(`Unsupported shell: ${shell}. Use 'bash' or 'zsh'.`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
