import type { Command } from 'commander';
import { stdin, stdout } from 'node:process';
import { moveCursor, clearScreenDown } from 'node:readline';
import { api } from '../lib/client.js';
import { readManifest } from '../lib/manifest.js';
import { color, fail, info } from '../lib/format.js';
import { enterSandbox } from '../lib/enter-sandbox.js';

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

interface JumpTarget {
  instanceId: string;
  appId: string;
  appName: string;
  state: string;
  port: number | null;
  isService: boolean;
  sandbox?: 'proot' | 'container';
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
    .description('Interactive picker: jump into a running app/service sandbox (proot or container) in this terminal.')
    .option('--no-services', 'Hide services, show only user apps')
    .option('--no-apps',     'Hide apps, show only services')
    .action(async (opts: { services?: boolean; apps?: boolean }) => {
      if (!stdin.isTTY || !stdout.isTTY) {
        fail('aura jump needs a TTY (you piped/redirected stdio). Use `aura inst shell <id>` for non-interactive.');
      }
      const targets = await collectTargets(opts.apps !== false, opts.services !== false);
      if (targets.length === 0) {
        info('No running instances to jump into. Launch an app first.');
        return;
      }
      const pick = await pickInteractively(targets);
      if (!pick) { info('jump cancelled'); return; }
      const manifest = readManifest(pick.appId);
      enterSandbox(pick.instanceId, pick.appId, pick.port, manifest?.tools ?? [], pick.sandbox, undefined);
    });
}

async function collectTargets(showApps: boolean, showServices: boolean): Promise<JumpTarget[]> {
  const apps = await api.get<AppDto[]>('/api/apps');
  const out: JumpTarget[] = [];
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
  const cursor   = selected ? color.green('▸') : ' ';
  const slot     = color.dim(`[${idx + 1}]`.padStart(4));
  const name     = (selected ? color.bold : color.green)(t.appName.padEnd(14));
  const state    = stateBadge(t.state);
  const inst     = color.dim(`· ${t.instanceId}`);
  const port     = t.port ? color.dim(`:${t.port}`) : '';
  return `  ${cursor} ${slot} ${name} ${state} ${inst} ${port}`;
}
function stateBadge(state: string): string {
  if (state === 'resumed') return color.green('● RUN ');
  if (state === 'paused')  return color.yellow('◐ PAUSE');
  return color.dim(state.padEnd(7));
}
function sectionHeader(label: string): string {
  return '\n  ' + color.dim(`── ${label} ${'─'.repeat(Math.max(0, 40 - label.length))}`);
}

async function pickInteractively(targets: JumpTarget[]): Promise<JumpTarget | null> {
  let idx = targets.findIndex((t) => !t.isService);
  if (idx < 0) idx = 0;

  // Pre-compute the section boundaries so renders + numbering are stable.
  const firstServiceIdx = targets.findIndex((t) => t.isService);

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
    let printedAppHeader = false;
    let printedSvcHeader = false;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      if (!t.isService && !printedAppHeader) {
        lines.push(sectionHeader('APPS'));
        printedAppHeader = true;
      }
      if (t.isService && !printedSvcHeader) {
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
    void firstServiceIdx; // silence unused
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
