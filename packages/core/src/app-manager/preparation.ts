import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { preparationWorker } from './preparation-worker.js';

export const PREPARATION_TIMEOUT_MS = 15 * 60_000;
export interface PreparationResult {
  status: 'ready' | 'externally-managed';
  action: 'verified' | 'installed' | 'repaired' | 'externally-managed';
  cached: boolean;
  durationMs: number;
}
export interface PreparationStatus {
  status: 'preparing' | 'ready' | 'failed' | 'externally-managed';
  phase?: string;
  error?: string;
  logPath?: string;
  result?: PreparationResult;
}
export interface PreparationRequest {
  stateDir: string;
  mutable: boolean;
  allowChanges: boolean;
  onLine?: (line: string) => void;
}
export class PreparationError extends Error {
  constructor(message: string, public readonly phase: string, public readonly logPath: string, public readonly exitCode?: number) {
    super(message); this.name = 'PreparationError';
  }
}
export const EXTERNAL_PREPARATION: PreparationResult = {
  status: 'externally-managed', action: 'externally-managed', cached: false, durationMs: 0,
};

/** One lock for preparation and launch registration, keyed by scoped source
 * path. Callers must not reacquire it inside their callback. */
export class AppPreparation {
  private locks = new Map<string, Promise<void>>();
  private pending = new Map<string, Promise<PreparationResult>>();
  isActive(appDir: string): boolean { return this.locks.has(this.key(appDir)); }
  key(appDir: string): string { return realpathSync(appDir); }
  async exclusive<T>(appDir: string, work: () => Promise<T>): Promise<T> {
    const key = this.key(appDir);
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(key, current);
    await previous;
    try { return await work(); }
    finally { release(); if (this.locks.get(key) === current) this.locks.delete(key); }
  }
  prepare(appDir: string, work: () => Promise<PreparationResult>): Promise<PreparationResult> {
    const key = this.key(appDir);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = this.exclusive(appDir, work).finally(() => { this.pending.delete(key); });
    this.pending.set(key, task);
    return task;
  }
}

export function preparationStateDir(dataDir: string, appDir: string): string {
  return join(dataDir, 'aura', 'preparation', createHash('sha256').update(realpathSync(appDir)).digest('hex'));
}
export function readPreparationStatus(stateDir: string): PreparationStatus | null {
  try { return JSON.parse(readFileSync(join(stateDir, 'status.json'), 'utf8')); } catch { return null; }
}
export function writePreparationStatus(stateDir: string, status: PreparationStatus): void {
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, 'status.json');
  writeFileSync(file + '.tmp', JSON.stringify(status)); renameSync(file + '.tmp', file);
}
export function preparationCommand(req: PreparationRequest, stateDir: string, runtime: string): string[] {
  const source = preparationWorker.toString();
  return ['node', '-e', `(${source})().catch(e=>{console.error(e.message);process.exitCode=1})`, JSON.stringify({
    stateDir, mutable: req.mutable, allowChanges: req.allowChanges, runtime,
    implementation: createHash('sha256').update(source).digest('hex'), timeoutMs: PREPARATION_TIMEOUT_MS - 5000,
  })];
}

/** Stream a preparation worker protocol without exposing raw environment or
 * command arguments. The adapter owns whole-runtime cleanup in finally. */
export function runPreparationCommand(command: string, args: string[], req: PreparationRequest,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<PreparationResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...opts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = ''; let stderr = ''; let result: PreparationResult | undefined;
    let failure: PreparationError | undefined;
    const logPath = join(req.stateDir, 'preparation.log');
    const timer = setTimeout(() => {
      failure = new PreparationError('Dependency preparation timed out', 'timeout', logPath);
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, PREPARATION_TIMEOUT_MS);
    function line(text: string): void {
      try {
        const event = JSON.parse(text);
        if (event.type === 'result') result = { status: event.status, action: event.action, cached: event.cached, durationMs: event.durationMs };
        else if (event.type === 'failure') failure = new PreparationError(event.message, event.phase, logPath, event.exitCode);
        else if (event.type === 'progress') req.onLine?.(event.line);
      } catch { stderr = (stderr + text).slice(-6000); }
    }
    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    });
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data).slice(-6000); });
    child.on('error', error => { clearTimeout(timer); reject(new PreparationError(error.message, 'runtime', logPath)); });
    child.on('close', code => {
      clearTimeout(timer); if (buffer) line(buffer);
      if (failure) reject(failure);
      else if (code !== 0 || !result) reject(new PreparationError(`Preparation runtime exited (${code}): ${stderr}`, 'runtime', logPath, code ?? undefined));
      else resolve(result);
    });
  });
}
