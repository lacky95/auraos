import type { Command } from 'commander';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync, unlinkSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { color, fail, info, ok, table } from '../lib/format.js';
import { ensureRegistry, installCapability, loadRegistry, loadState, removeCapability, saveState, type ServiceEntry } from '../lib/registry.js';

const SERVICES_DIR = '/data/aura/state/services';

function pidFile(name: string): string {
  mkdirSync(SERVICES_DIR, { recursive: true });
  return join(SERVICES_DIR, `${name}.pid`);
}

/** Where a service's stdout/stderr go (appended across starts). */
function logFile(name: string): string {
  mkdirSync(SERVICES_DIR, { recursive: true });
  return join(SERVICES_DIR, `${name}.log`);
}

/** Last `n` lines of a file (whole file when small; reads only the tail otherwise). */
function tailLines(path: string, n: number): string {
  const size = statSync(path).size;
  const want = Math.min(size, Math.max(64 * 1024, n * 512));
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(want);
    readSync(fd, buf, 0, want, size - want);
    const lines = buf.toString('utf-8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-n).join('\n') + (lines.length ? '\n' : '');
  } finally { closeSync(fd); }
}

/** Print the tail of a service log, optionally following it (poll — no extra deps). */
export async function serviceLogs(name: string, opts: { follow?: boolean; tail?: string }): Promise<void> {
  const lf = logFile(name);
  if (!existsSync(lf)) fail(`no log for ${name} yet — it is written from its next \`aura start svc ${name}\``);
  const n = Math.max(1, Number(opts.tail ?? 100) || 100);
  process.stdout.write(tailLines(lf, n));
  if (!opts.follow) return;
  let pos = statSync(lf).size;
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    let size: number;
    try { size = statSync(lf).size; } catch { continue; }
    if (size < pos) pos = 0;                 // truncated / recreated
    if (size === pos) continue;
    const fd = openSync(lf, 'r');
    try {
      const buf = Buffer.alloc(size - pos);
      readSync(fd, buf, 0, buf.length, pos);
      process.stdout.write(buf);
    } finally { closeSync(fd); }
    pos = size;
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function registerService(program: Command): void {
  const svc = program.command('service').alias('svc').description('Manage long-running daemons (sshd, code-server, …) on the master.');

  svc
    .command('list')
    .alias('ls')
    .description('List services from the registry with installed + running status.')
    .action(() => {
      ensureRegistry();
      const reg = loadRegistry();
      const state = loadState();
      const rows = Object.entries(reg.services).map(([name, entry]) => {
        const pf = pidFile(name);
        const installed = state.services[name]?.installed === true;
        let running = false;
        if (existsSync(pf)) {
          const pid = Number(readFileSync(pf, 'utf-8').trim());
          running = Number.isFinite(pid) && isAlive(pid);
        }
        return {
          NAME:      name,
          SOURCE:    entry.source,
          INSTALLED: installed ? color.green('✓') : color.dim('✗'),
          RUNNING:   running ? color.green('✓') : color.dim('✗'),
          PORT:      entry.port?.toString() ?? '-',
        };
      });
      console.log(table(rows, ['NAME', 'SOURCE', 'INSTALLED', 'RUNNING', 'PORT']));
    });

  svc
    .command('install <name>')
    .description('Install a service from the registry (apt/npm/curl).')
    .action(async (name: string) => {
      ensureRegistry();
      const reg = loadRegistry();
      const entry = reg.services[name];
      if (!entry) fail(`Unknown service: ${name}`);
      info(`Installing service ${color.bold(name)} (source=${entry.source}) …`);
      const result = await installCapability(name, entry);
      const state = loadState();
      state.services[name] = { installed: true, installedAt: new Date().toISOString(), version: result.version ?? null };
      saveState(state);
      ok(`installed service ${name}`);
    });

  svc
    .command('start <name>')
    .description('Start a daemon detached. Records PID in /data/aura/state/services/<name>.pid.')
    .action((name: string) => {
      ensureRegistry();
      const reg = loadRegistry();
      const entry = reg.services[name];
      if (!entry) fail(`Unknown service: ${name}`);
      const pf = pidFile(name);
      if (existsSync(pf)) {
        const pid = Number(readFileSync(pf, 'utf-8').trim());
        if (Number.isFinite(pid) && isAlive(pid)) { info(`${name} already running (pid ${pid})`); return; }
        unlinkSync(pf);
      }
      const cmd = entry.start_cmd;
      if (!cmd) fail(`Service ${name} has no start_cmd in registry`);
      // Output goes to a per-service log (appended), so `aura logs svc` has something to read.
      const out = openSync(logFile(name), 'a');
      writeSync(out, `\n--- ${new Date().toISOString()} aura start svc ${name}: ${cmd}\n`);
      const child = spawn('sh', ['-c', cmd], { detached: true, stdio: ['ignore', out, out] });
      closeSync(out);
      child.unref();
      if (child.pid) writeFileSync(pf, String(child.pid));
      ok(`started ${name} (pid ${child.pid ?? '?'}${entry.port ? `, port ${entry.port}` : ''})`);
    });

  svc
    .command('stop <name>')
    .description('Send SIGTERM to a running service.')
    .action((name: string) => {
      const pf = pidFile(name);
      if (!existsSync(pf)) { info(`${name} is not running`); return; }
      const pid = Number(readFileSync(pf, 'utf-8').trim());
      if (Number.isFinite(pid) && isAlive(pid)) {
        try { process.kill(pid, 'SIGTERM'); ok(`stopped ${name} (pid ${pid})`); }
        catch (err) { fail(`Failed to stop ${name}: ${String(err)}`); }
      } else {
        info(`stale pid file for ${name} (process gone)`);
      }
      unlinkSync(pf);
    });

  svc
    .command('status <name>')
    .description('Show installed + running status and registry config for a service.')
    .action((name: string) => {
      ensureRegistry();
      const reg = loadRegistry();
      const entry = reg.services[name] as ServiceEntry | undefined;
      if (!entry) fail(`Unknown service: ${name}`);
      const pf = pidFile(name);
      let running = false; let pid: number | undefined;
      if (existsSync(pf)) {
        pid = Number(readFileSync(pf, 'utf-8').trim());
        running = Number.isFinite(pid) && isAlive(pid);
      }
      const state = loadState();
      console.log(color.bold(name));
      console.log(JSON.stringify({
        installed: state.services[name] ?? false,
        running,
        pid: running ? pid : null,
        registry: entry,
      }, null, 2));
    });

  svc
    .command('logs <name>')
    .option('-f, --follow', 'Follow new log lines')
    .option('--tail <n>', 'Lines to show first', '100')
    .description(`Show a service's output (written to ${SERVICES_DIR}/<name>.log since its last start).`)
    .action(async (name: string, opts: { follow?: boolean; tail?: string }) => {
      await serviceLogs(name, opts);
    });

  svc
    .command('uninstall <name>')
    .description('Stop (if running) and uninstall a service.')
    .action(async (name: string) => {
      ensureRegistry();
      const reg = loadRegistry();
      const entry = reg.services[name];
      if (!entry) fail(`Unknown service: ${name}`);
      const pf = pidFile(name);
      if (existsSync(pf)) {
        const pid = Number(readFileSync(pf, 'utf-8').trim());
        if (Number.isFinite(pid) && isAlive(pid)) {
          try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
        }
        unlinkSync(pf);
      }
      await removeCapability(name, entry);
      const state = loadState();
      delete state.services[name];
      saveState(state);
      ok(`uninstalled service ${name}`);
    });
}
