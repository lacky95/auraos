/**
 * App-id / scope helpers shared by the `aura dev` subcommands.
 *
 * These started life inside `commands/dev.ts`. They moved here when
 * `dev clone` landed in its own file: importing them from `dev.ts` would have
 * created a cycle (`dev.ts` → `dev-clone.ts` → `dev.ts`), and both commands
 * must agree on what a valid app id is and where a scope's apps actually live.
 */
import { join } from 'node:path';
import { color } from './format.js';

const APPS_DIR = process.env['AURA_APPS_DIR'] ?? '/workspace/apps';
const DATA_DIR = process.env['AURA_DATA_DIR'] ?? '/data';

export type ScopeId = 'system' | 'global' | 'user';

/** All scope apps dirs in AppRegistry priority order (system→global→user). */
export const ALL_SCOPES: ScopeId[] = ['system', 'global', 'user'];

/**
 * Scopes a developer may target with `aura dev new` / `aura dev clone`.
 * `system` is deliberately excluded: it's the immutable in-repo monorepo scope
 * (workspace:* deps, lives in /workspace/apps) and must NEVER be a write
 * target for the CLI. System apps can still be READ — `dev clone` happily
 * clones one — they just can't be written back into that scope. The scaffold
 * API and Nexus still know about system for internal/legacy use, but the CLI
 * neither offers it in a wizard nor accepts it via --scope. New apps are
 * `user` by default, or `global` if opted into.
 */
export const SELECTABLE_SCOPES = ['user', 'global'] as const;
export type SelectableScope = typeof SELECTABLE_SCOPES[number];

/** Reverse-domain app id. Same regex `AppManifestSchema` and the shell use. */
export const PKG_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

/** Strict semver, matching the manifest schema's `version` field. */
export const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * Host-side apps directory for a scope — mirrors core's ScopeRegistry so
 * wizard previews, flag paths, and offline fallbacks all agree on where an app
 * actually lands (rather than always assuming the system /workspace/apps dir).
 */
export function scopeAppsDir(scope: ScopeId): string {
  switch (scope) {
    case 'system': return APPS_DIR;
    case 'global': return join(DATA_DIR, 'scopes', 'global', 'apps');
    case 'user':   return join(DATA_DIR, 'scopes', 'users', 'default', 'apps');
  }
}

/**
 * 1-3 char launch glyph, uppercase. Prefers the first letters of camelCase /
 * space-split words so "TaskList" → "TL", "voice memo" → "VM". Falls back to
 * the first letter.
 */
export function defaultIconFor(name: string): string {
  const words = name.split(/[\s.-]+|(?=[A-Z])/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0]![0]! + words[1]![0]!).toUpperCase();
  }
  return (name[0] ?? '?').toUpperCase();
}

/** Consistent colour per scope across every command that prints one. */
export function scopeColor(scope: string): string {
  if (scope === 'system') return color.magenta(scope);
  if (scope === 'global') return color.cyan(scope);
  if (scope === 'user')   return color.green(scope);
  return color.dim(scope);
}

export function stdoutDivider(): void {
  process.stdout.write(color.dim('  ────────────────────────────────────────────────────\n'));
}
