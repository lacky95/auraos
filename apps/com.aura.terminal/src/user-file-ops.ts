/**
 * What the Terminal reads and writes in the user's own home: the agent hooks
 * (agent-hooks.ts) and the quick commands (quick-commands-store.ts). One table
 * for both callers (user-files.ts): run directly when this server is the
 * session user, or by user-files.mjs as the session user when this server is
 * the Terminal service uid (stream T2), which can't open the Private Home.
 * Node builtins only.
 */
import { hookStatus, installHooks, refreshHookScript, uninstallHooks } from './agent-hooks.ts';
import { load, sanitize, save, storeFile } from './quick-commands-store.ts';

export const USER_FILE_OPS = {
  'hooks-status': (_input?: unknown) => hookStatus(),
  'hooks-install': (_input?: unknown) => installHooks(),
  'hooks-uninstall': (_input?: unknown) => uninstallHooks(),
  'hooks-refresh': (_input?: unknown) => refreshHookScript(),
  'quick-get': (_input?: unknown) => ({ commands: load(), file: storeFile() }),
  'quick-put': (input?: unknown) => {
    const commands = sanitize((input as { commands?: unknown } | null)?.commands);
    save(commands);
    return { commands };
  },
} as const satisfies Record<string, (input?: unknown) => unknown>;

export type UserFileOp = keyof typeof USER_FILE_OPS;

export function isUserFileOp(op: string): op is UserFileOp {
  return Object.prototype.hasOwnProperty.call(USER_FILE_OPS, op);
}
