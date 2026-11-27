/**
 * The user's own files, as the user (stream T2). This server runs as the
 * Terminal service uid and can't open the Private Home, so under the session
 * launcher an operation runs as `node user-files.mjs <op>` through
 * `aura-term-launch run` (the session user, the session environment); its
 * answer is data (one JSON line), never trusted beyond that. Without the
 * launcher (this server is the user) it runs in-process.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { asSessionUser, sessionEnv, sessionLauncher } from './tmux-control.ts';
import { USER_FILE_OPS, type UserFileOp } from './user-file-ops.ts';

const TIMEOUT_MS = 10_000;
const MAX_OUT = 4 * 1024 * 1024;

export async function userFiles<T = unknown>(op: UserFileOp, input?: unknown): Promise<T> {
  if (!sessionLauncher()) return USER_FILE_OPS[op](input) as T;
  const helper = join(process.cwd(), 'user-files.mjs');
  const c = asSessionUser(process.execPath, ['--no-warnings', helper, op]);
  return new Promise<T>((resolve, reject) => {
    const child = spawn(c.file, c.args, { env: sessionEnv(), stdio: ['pipe', 'pipe', 'pipe'], timeout: TIMEOUT_MS });
    let out = ''; let err = '';
    child.stdout.setEncoding('utf-8').on('data', (d: string) => { if (out.length < MAX_OUT) out += d; });
    child.stderr.setEncoding('utf-8').on('data', (d: string) => { if (err.length < 4096) err += d; });
    child.stdin.on('error', () => { /* it exited first: the exit reports it */ });
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
    child.on('error', reject);
    child.on('close', (code) => {
      let msg: { ok?: boolean; value?: unknown; error?: string } | null = null;
      try { msg = JSON.parse(out) as typeof msg; } catch { msg = null; }
      if (code === 0 && msg?.ok) return resolve(msg.value as T);
      reject(new Error(msg?.error ?? `${op} as the session user failed (exit ${code})${err ? `: ${err.trim().split('\n').pop()}` : ''}`));
    });
  });
}
