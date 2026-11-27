/**
 * This start's lifecycle token, the one secret the kernel and an app share
 * (lifecycle calls, the shell's relay claim key, D89 B4). Most apps get it in
 * `AURA_LIFECYCLE_TOKEN`. A user's session host (the System Terminal, stream
 * T/T2) never has it in its env: the runtime hands it over as a one-time file
 * (`AURA_LIFECYCLE_TOKEN_FILE`, 0400 in a 0700 directory of the server's own
 * service uid, which its users' sessions don't share), which the first call
 * here reads (O_NOFOLLOW; Node opens with O_CLOEXEC, and the descriptor is
 * closed at once) and removes. The value then lives only in this process's
 * memory. Undefined when there is none (an app
 * started by hand).
 */
import { closeSync, constants, openSync, readFileSync, unlinkSync } from 'node:fs';

export const LIFECYCLE_TOKEN_FILE_ENV = 'AURA_LIFECYCLE_TOKEN_FILE';
const KEY = Symbol.for('aura.lifecycle.secret');

/** Reads and removes the one-time file; '' when it is not there (any more). */
export function takeSecretFile(path: string): string {
  let value = '';
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { value = readFileSync(fd, 'utf-8').trim(); } finally { closeSync(fd); }
  } catch { value = ''; }
  try { unlinkSync(path); } catch { /* already gone */ }
  return value;
}

export function lifecycleSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env['AURA_LIFECYCLE_TOKEN']) return env['AURA_LIFECYCLE_TOKEN'];
  const g = globalThis as Record<symbol, unknown>;
  if (typeof g[KEY] === 'string' && g[KEY]) return g[KEY] as string;
  const file = env[LIFECYCLE_TOKEN_FILE_ENV];
  if (!file) return undefined;
  const value = takeSecretFile(file);
  if (value) g[KEY] = value;
  return value || undefined;
}
