/**
 * `aura scope *` — inspect and configure app installation scopes.
 *
 *   aura scope list
 */
import type { Command } from 'commander';
import { api } from '../lib/client.js';
import { table } from '../lib/format.js';

interface ScopeStatus {
  id:        string;
  appsDir:   string;
  dataDir:   string;
  immutable: boolean;
  priority:  number;
  appCount:  number;
  gitRepo:   string | null;
}

export function registerScope(program: Command): void {
  const scope = program
    .command('scope')
    .description('Inspect and configure app installation scopes (system / global / user).');

  scope
    .command('list')
    .description('List all scopes with their app counts, paths, and git repo config.')
    .action(async () => {
      const scopes = await api.get<ScopeStatus[]>('/api/scopes');
      console.log(table(
        scopes.map((s) => ({
          scope:     s.id,
          apps:      String(s.appCount),
          immutable: s.immutable ? 'yes' : 'no',
          appsDir:   s.appsDir,
          gitRepo:   s.gitRepo ?? '—',
        })),
        ['scope', 'apps', 'immutable', 'appsDir', 'gitRepo'],
      ));
    });
}
