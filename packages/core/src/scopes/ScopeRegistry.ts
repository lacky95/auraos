/**
 * ScopeRegistry — builds and serves the three fixed scope definitions
 * (system, global, user) from the root dataDir and systemAppsDir.
 *
 * Path layout:
 *   system  appsDir = systemAppsDir (AURA_APPS_DIR)
 *           dataDir = dataDir/scopes/system
 *   global  appsDir = dataDir/scopes/global/apps
 *           dataDir = dataDir/scopes/global
 *   user    appsDir = dataDir/scopes/users/default/apps   ← DEFAULT_USER_ID = 'default'
 *           dataDir = dataDir/scopes/users/default
 *
 * The user scope path uses DEFAULT_USER_ID = 'default'. When multi-user
 * support arrives, nothing in this class changes — the path structure is
 * already ready for it.
 *
 * Global and user scope dirs are initialized as independent git repos on
 * first install via ensureScopeRepo(). An optional remote URL is stored in
 * KV by the shell API layer (not here — core doesn't depend on kv-store).
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScopeDefinition, ScopeId } from './types.js';

export const DEFAULT_USER_ID = 'default';

export class ScopeRegistry {
  private readonly scopes: ScopeDefinition[];
  private readonly rootDataDir: string;

  constructor(opts: { systemAppsDir: string; dataDir: string }) {
    this.rootDataDir = opts.dataDir;
    this.scopes = [
      {
        id:        'system',
        appsDir:   opts.systemAppsDir,
        dataDir:   join(opts.dataDir, 'scopes', 'system'),
        immutable: true,
        priority:  0,
      },
      {
        id:        'global',
        appsDir:   join(opts.dataDir, 'scopes', 'global', 'apps'),
        dataDir:   join(opts.dataDir, 'scopes', 'global'),
        immutable: false,
        priority:  1,
      },
      {
        id:        'user',
        appsDir:   join(opts.dataDir, 'scopes', 'users', DEFAULT_USER_ID, 'apps'),
        dataDir:   join(opts.dataDir, 'scopes', 'users', DEFAULT_USER_ID),
        immutable: false,
        priority:  2,
      },
    ];
  }

  /** All three scope definitions sorted by priority ascending (0→2). */
  getAll(): ScopeDefinition[] {
    return this.scopes.slice();
  }

  getById(id: ScopeId): ScopeDefinition {
    const s = this.scopes.find((s) => s.id === id);
    if (!s) throw new Error(`[ScopeRegistry] unknown scope: ${id}`);
    return s;
  }

  /**
   * Ensure the scope's dataDir and appsDir exist and the dataDir is a git
   * repository. Idempotent — safe to call on every install.
   * Called by NexusManager before the first install into a scope.
   */
  async ensureScopeRepo(id: 'global' | 'user'): Promise<void> {
    const scope = this.getById(id);
    mkdirSync(scope.appsDir, { recursive: true });
    mkdirSync(scope.dataDir, { recursive: true });

    const gitDir = join(scope.dataDir, '.git');
    if (existsSync(gitDir)) return;

    execFileSync('git', ['init', '-b', 'main', scope.dataDir], { stdio: 'ignore' });

    // Configure a local identity if none is set — git commit fails without one
    // and the container may not have a global gitconfig.
    try {
      execSync('git config user.email', { cwd: scope.dataDir, stdio: 'ignore' });
    } catch {
      execFileSync('git', ['config', 'user.email', 'aura@localhost'], { cwd: scope.dataDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name',  'AuraOS'],         { cwd: scope.dataDir, stdio: 'ignore' });
    }

    const markerPath = join(scope.dataDir, '.aura-scope');
    writeFileSync(markerPath, JSON.stringify({ scope: id, createdAt: new Date().toISOString() }, null, 2) + '\n');

    execFileSync('git', ['add', '.aura-scope'], { cwd: scope.dataDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', `init: ${id} scope`], { cwd: scope.dataDir, stdio: 'ignore' });
  }

  /** Root data dir — used by NexusManager for shared staging/index paths. */
  getRootDataDir(): string {
    return this.rootDataDir;
  }
}
