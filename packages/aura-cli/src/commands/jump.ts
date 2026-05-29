import type { Command } from 'commander';
import { stdin, stdout, env as procEnv } from 'node:process';
import { spawn } from 'node:child_process';
import { moveCursor, clearScreenDown } from 'node:readline';
import { api } from '../lib/client.js';
import { readManifest } from '../lib/manifest.js';
import { color, fail, info, ok, warn } from '../lib/format.js';
import { enterSandbox, syncDockerExecWinsize, setTerminalHost, callerHostLabel } from '../lib/enter-sandbox.js';

interface InstanceLite {
  instanceId: string;
  appId: string;
  state: string;
  port: number | null;
  inPool?: boolean;
  sandbox?: 'proot' | 'container';
}
interface AppDto {
  manifest: { id: string; name: string; componentType?: 'activity' | 'service' };
  instances: InstanceLite[];
}

/** Discriminated union: `kind: 'instance'` is the app/service rows we
 *  already had; `kind: 'master'` is the new shortcut into `aura-shell`. */
type JumpTarget =
  | {
      kind: 'instance';
      instanceId: string;
      appId: string;
      appName: string;
      state: string;
      port: number | null;
      isService: boolean;
      sandbox?: 'proot' | 'container';
    }
  | {
      kind: 'master';
      appName: string;       // 'MASTER' — kept for renderRow uniformity
      state: string;         // 'shell' — purely cosmetic in the picker
    };

const MASTER_CONTAINER = 'aura-shell';

/** True when the calling process is already inside the master container.
 *  Detected via $HOSTNAME (docker sets this to the container name unless
 *  the caller overrides). Used to hide the MASTER picker row so we don't
 *  offer "jump into the place you already are". */
function isInsideMaster(): boolean {
  return (procEnv['HOSTNAME'] ?? '') === MASTER_CONTAINER;
}

/**
 * Interactive picker: arrow-key list of running app/service instances.
 * Enter selects → exec proot in the current terminal (same session, no
 * subshell — when the user `exit`s the proot they're back where they
 * launched `aura jump` from).
 */
export function registerJump(program: Command): void {
  program
    .command('jump')
    .alias('j')
    .description('Interactive picker: jump into a running app/service sandbox (proot or container) in this terminal. Pass --master to skip the picker and drop into the aura-shell master container.')
    .option('--no-services', 'Hide services, show only user apps')
    .option('--no-apps',     'Hide apps, show only services')
    .option('-m, --master',  'Skip the picker and jump straight into the aura-shell master container')
    .action(async (opts: { services?: boolean; apps?: boolean; master?: boolean }) => {
      if (!stdin.isTTY || !stdout.isTTY) {
        fail('aura jump needs a TTY (you piped/redirected stdio). Use `aura inst shell <id>` for non-interactive.');
      }
      if (opts.master) { enterMasterContainer(); return; }
      const instanceTargets = await collectTargets(opts.apps !== false, opts.services !== false);
      // Master is always offered (unless we're already inside it) — it's a
      // useful escape hatch even when no apps are running, so we don't
      // honour --no-apps / --no-services for it.
      const targets: JumpTarget[] = [];
      if (!isInsideMaster()) targets.push({ kind: 'master', appName: 'MASTER', state: 'shell' });
      targets.push(...instanceTargets);
      if (targets.length === 0) {
        info('No running instances to jump into. Launch an app first.');
        return;
      }
      const pick = await pickInteractively(targets);
      if (!pick) { info('jump cancelled'); return; }
      if (pick.kind === 'master') { enterMasterContainer(); return; }
      const manifest = readManifest(pick.appId);
      enterSandbox(pick.instanceId, pick.appId, pick.port, manifest?.tools ?? [], pick.sandbox, undefined);
    });
}

/** `docker exec -it aura-shell bash` — same TUI env passthrough we use for
 *  app containers in enter-sandbox.ts so claude/htop/vim render with the
 *  rich UI inside the master shell too. Requires the calling sandbox to
 *  have the docker CLI on PATH and /var/run/docker.sock bind-mounted —
 *  same prerequisites as jumping into any sibling container. */
function enterMasterContainer(): void {
  const passthrough: Record<string, string> = {
    TERM:      procEnv['TERM']      ?? 'xterm-256color',
    COLORTERM: procEnv['COLORTERM'] ?? 'truecolor',
    LANG:      procEnv['LANG']      ?? 'C.UTF-8',
    LC_ALL:    procEnv['LC_ALL']    ?? 'C.UTF-8',
  };
  const envFlags: string[] = [];
  for (const [k, v] of Object.entries(passthrough)) envFlags.push('-e', `${k}=${v}`);
  const args = ['exec', '-it', ...envFlags, MASTER_CONTAINER, 'bash', '-i'];
  // Loud, multi-line banner — the master shell is the AuraOS process itself
  // (PID 1 in aura-shell). Filesystem edits hit /workspace, /os, and /data
  // directly; misbehaving processes can wedge the shell, the AppManager,
  // or every running sandbox at once. App containers are throwaway; this
  // one is not.
  warn(`${color.bold('CAUTION')} — entering ${color.bold(MASTER_CONTAINER)} (master container)`);
  warn(`Changes here run inside the live AuraOS shell process. Editing /workspace,`);
  warn(`/os, /data, or killing the wrong process can break the entire OS. Prefer`);
  warn(`an app sandbox unless you know exactly what you're touching.`);
  info(`entering master container ${color.bold(MASTER_CONTAINER)}`);
  // Update the Terminal's host indicator to the master host, restore on exit.
  const restoreHost = callerHostLabel();
  setTerminalHost(MASTER_CONTAINER);
  const child = spawn('docker', args, { stdio: 'inherit' });
  syncDockerExecWinsize(child);
  child.on('exit', (code) => {
    setTerminalHost(restoreHost);
    ok(`shell exited (code ${code ?? 0})`); process.exit(code ?? 0);
  });
  child.on('error', (err) => fail(
    `docker exec failed: ${err.message}\n` +
    `  Hint: the calling sandbox needs both the docker CLI on PATH and a bound /var/run/docker.sock.`
  ));
}

async function collectTargets(showApps: boolean, showServices: boolean): Promise<Extract<JumpTarget, { kind: 'instance' }>[]> {
  const apps = await api.get<AppDto[]>('/api/apps');
  const out: Extract<JumpTarget, { kind: 'instance' }>[] = [];
  for (const a of apps) {
    const isService = a.manifest.componentType === 'service';
    if (isService && !showServices) continue;
    if (!isService && !showApps)     continue;
    for (const inst of a.instances) {
      // Skip warm-pool members — they're spawn-warmed but not user-attached,
      // and jumping into one would consume the pool slot in a surprising way.
      if (inst.inPool) continue;
      // Skip dead or pre-resumed instances: a `creating`/`destroyed` proot
      // isn't actually serving anything to jump into.
      if (inst.state !== 'resumed' && inst.state !== 'paused' && inst.state !== 'started') continue;
      out.push({
        kind:       'instance',
        instanceId: inst.instanceId,
        appId:      inst.appId,
        appName:    a.manifest.name,
        state:      inst.state,
        port:       inst.port,
        isService,
        sandbox:    inst.sandbox,
      });
    }
  }
  // Sort: apps first (alphabetical), then services. Within each group keep
  // the AppManager's natural instance order so a returning user sees stable
  // numbering across calls.
  out.sort((x, y) => {
    if (x.isService !== y.isService) return x.isService ? 1 : -1;
    if (x.appName   !== y.appName)   return x.appName.localeCompare(y.appName);
    return x.instanceId.localeCompare(y.instanceId);
  });
  return out;
}

// ─── Picker ────────────────────────────────────────────────────────────────
// Minimal arrow-key picker. Renders once, redraws in-place on key events by
// moving the cursor up by the number of lines previously written. Avoids
// pulling in a 200KB-min picker library — the CLI is bundled with esbuild and
// the user runs it from inside a small proot, so size matters.

const KEY_UP    = '[A';
const KEY_DOWN  = '[B';
const KEY_ENTER = '\r';
const KEY_ESC   = '';
const KEY_CTRLC = '';

function renderRow(t: JumpTarget, selected: boolean, idx: number): string {
  const cursor = selected ? color.green('▸') : ' ';
  const slot   = color.dim(`[${idx + 1}]`.padStart(4));
  const name   = (selected ? color.bold : color.green)(t.appName.padEnd(14));
  const state  = stateBadge(t.state);
  if (t.kind === 'master') {
    // Master row: no instance id or port, just a fixed label so it stands
    // out from the app/service rows that follow.
    const label = color.dim('· aura-shell (master container)');
    return `  ${cursor} ${slot} ${name} ${state} ${label}`;
  }
  const inst = color.dim(`· ${t.instanceId}`);
  const port = t.port ? color.dim(`:${t.port}`) : '';
  return `  ${cursor} ${slot} ${name} ${state} ${inst} ${port}`;
}
function stateBadge(state: string): string {
  if (state === 'resumed') return color.green('● RUN ');
  if (state === 'paused')  return color.yellow('◐ PAUSE');
  if (state === 'shell')   return color.green('◆ HOST');
  return color.dim(state.padEnd(7));
}
function sectionHeader(label: string): string {
  return '\n  ' + color.dim(`── ${label} ${'─'.repeat(Math.max(0, 40 - label.length))}`);
}

async function pickInteractively(targets: JumpTarget[]): Promise<JumpTarget | null> {
  // Default selection: prefer the first app instance (most common case).
  // Fall back to whatever is first in the list — that's MASTER when nothing
  // is running, which is the only reachable target then anyway.
  let idx = targets.findIndex((t) => t.kind === 'instance' && !t.isService);
  if (idx < 0) idx = 0;

  let linesWritten = 0;

  const draw = (firstTime: boolean) => {
    if (!firstTime) {
      moveCursor(stdout, 0, -linesWritten);
      clearScreenDown(stdout);
    }
    const lines: string[] = [];
    lines.push('');
    lines.push('  ' + color.bold('AURA  JUMP'));
    lines.push(color.dim('  ↑↓ navigate   1–9 quick-pick   ↵ enter   q/^C cancel'));
    let printedMasterHeader = false;
    let printedAppHeader = false;
    let printedSvcHeader = false;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      if (t.kind === 'master' && !printedMasterHeader) {
        lines.push(sectionHeader('MASTER'));
        printedMasterHeader = true;
      }
      if (t.kind === 'instance' && !t.isService && !printedAppHeader) {
        lines.push(sectionHeader('APPS'));
        printedAppHeader = true;
      }
      if (t.kind === 'instance' && t.isService && !printedSvcHeader) {
        lines.push(sectionHeader('SERVICES'));
        printedSvcHeader = true;
      }
      lines.push(renderRow(t, i === idx, i));
    }
    lines.push('');
    const text = lines.join('\n') + '\n';
    stdout.write(text);
    // Count newlines in the rendered text directly rather than `lines.length`:
    // sectionHeader() embeds a leading '\n' (blank separator before the header),
    // so each section adds two terminal rows but only one array slot. Counting
    // newlines is sandbox-proof against any future embedded \n in row strings.
    linesWritten = (text.match(/\n/g) ?? []).length;
  };

  return new Promise<JumpTarget | null>((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const onData = (data: string) => {
      // Esc is intentionally NOT a cancel key — pressing Esc inside a
      // browser-fullscreen terminal would exit fullscreen. Use Ctrl-C or 'q'
      // (handled further down) to cancel the picker instead.
      if (data === KEY_ESC) return;
      if (data === KEY_CTRLC) {
        cleanup();
        resolve(null);
        return;
      }
      if (data === KEY_ENTER) {
        cleanup();
        resolve(targets[idx] ?? null);
        return;
      }
      if (data === KEY_UP) {
        idx = (idx - 1 + targets.length) % targets.length;
        draw(false);
        return;
      }
      if (data === KEY_DOWN) {
        idx = (idx + 1) % targets.length;
        draw(false);
        return;
      }
      // Digit 1-9 → quick pick that slot
      if (data >= '1' && data <= '9') {
        const n = parseInt(data, 10) - 1;
        if (n < targets.length) {
          idx = n;
          cleanup();
          resolve(targets[idx]!);
          return;
        }
      }
      // 'q' to quit, vim-style hjkl
      if (data === 'q') { cleanup(); resolve(null); return; }
      if (data === 'k') { idx = (idx - 1 + targets.length) % targets.length; draw(false); return; }
      if (data === 'j') { idx = (idx + 1) % targets.length; draw(false); return; }
    };

    stdin.on('data', onData);
    draw(true);
  });
}
