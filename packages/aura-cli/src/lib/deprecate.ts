/**
 * The pre-kubectl command groups (`aura app …`, `aura inst …`, …) stay fully
 * working but leave the help output. When a human runs one, a single stderr
 * line names the new form; scripts (no TTY) and the verbs' own internal
 * dispatch (commands/verbs.ts) never see it.
 */
import type { Command } from 'commander';
import { color } from './format.js';

/** `<group> <sub>` → the new command. `<group>` alone covers a group without subcommands. */
export const LEGACY_HINTS: Record<string, string> = {
  'app list':         'aura get apps',
  'app info':         'aura describe app <appId>',
  'app start':        'aura run <appId>',
  'app stop':         'aura stop app <appId>',
  'app restart':      'aura restart app <appId>',
  'app install':      'aura install app <path>',
  'app remove':       'aura delete app <appId>',
  'app enable':       'aura enable app <appId>',
  'app disable':      'aura disable app <appId>',
  'perm ls':          'aura get perms [appId]',
  'perm grant':       'aura grant perm <appId> [permissions...]',
  'perm revoke':      'aura revoke perm <appId> <permissions...>',
  'inst list':        'aura get inst [-a <appId>]',
  'inst info':        'aura describe inst <instanceId>',
  'inst stop':        'aura stop inst <instanceId>',
  'inst kill':        'aura kill inst <instanceId>',
  'inst pause':       'aura pause inst <instanceId>',
  'inst resume':      'aura resume inst <instanceId>',
  'inst shell':       'aura exec inst <instanceId> [-- cmd]  (or: aura jump <instanceId>)',
  'inst logs':        'aura logs inst <instanceId>',
  'activity list':    'aura get act [-i <instanceId>]',
  'activity open':    'aura open act <instanceId>',
  'activity close':   'aura delete act <activityId>',
  'service list':     'aura get svc',
  'service install':  'aura install svc <name>',
  'service start':    'aura start svc <name>',
  'service stop':     'aura stop svc <name>',
  'service status':   'aura describe svc <name>',
  'service logs':     'aura logs svc <name>',
  'service uninstall':'aura delete svc <name>',
  'theme list':       'aura get themes',
  'theme get':        'aura get themes',
  'theme set':        'aura set theme <id> [--tone light|dark]',
  'scope list':       'aura get scopes',
  'whereami':         'aura info',
};

/** Groups that are hidden. `sdk` is hidden but silent — it runs on every app boot. */
export const LEGACY_GROUPS = ['app', 'inst', 'activity', 'service', 'theme', 'scope', 'sdk', 'whereami'] as const;
const SILENT = new Set(['sdk']);

export function hintsEnabled(): boolean {
  return process.stderr.isTTY === true
    && process.env['AURA_DEPRECATION_HINTS'] !== '0'
    && process.env['AURA_INTERNAL_DISPATCH'] !== '1';
}

/** Hide a registered legacy group from help and attach its hint. */
export function markLegacy(program: Command, group: string): void {
  const cmd = program.commands.find((c) => c.name() === group);
  if (!cmd) return;
  // Commander has no public setter after creation; `_hidden` is what
  // `.command(name, { hidden: true })` sets (stable across commander 9–12).
  (cmd as unknown as { _hidden: boolean })._hidden = true;
  if (SILENT.has(group)) return;
  cmd.hook('preAction', (_this, action) => {
    if (!hintsEnabled()) return;
    // Full path as typed (`app perm grant`); the table keys nested groups by
    // their last two words (`perm grant`).
    const path: string[] = [];
    for (let c: typeof action | null = action; c && c.parent; c = c.parent) path.unshift(c.name());
    const key = path.length > 2 ? path.slice(-2).join(' ') : path.join(' ');
    const hint = LEGACY_HINTS[key];
    if (hint) process.stderr.write(color.dim(`deprecated: \`aura ${path.join(' ')}\` → use \`${hint}\`\n`));
  });
}
