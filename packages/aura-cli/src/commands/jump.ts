import type { Command } from 'commander';
import { stdin, stdout, env as procEnv } from 'node:process';
import { spawn } from 'node:child_process';
import { moveCursor, clearScreenDown } from 'node:readline';
import { api } from '../lib/client.js';
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
      // Pull the app's tools + scope-correct sandbox paths from the
      // registry-backed instance DTO (works for system/global/user scopes),
      // rather than reading a hardcoded /workspace/apps manifest.
      const dto = await api.get<{
        launch?: { appDir?: string; instanceDataDir?: string; tools?: string[] };
      }>(`/api/instances/${encodeURIComponent(pick.instanceId)}/status`);
      enterSandbox(pick.instanceId, pick.appId, pick.port, dto.launch?.tools ?? [], pick.sandbox, undefined, dto.launch);
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
//
// The frame is always sized to the terminal: at most rows-1 physical lines
// (so the cursor-up redraw move can never run off the top of the screen) and
// every line clipped to the terminal width (so nothing hard-wraps and breaks
// the line count). When the list is taller than the window it scrolls behind
// dim "↑/↓ N more" indicators, and on short terminals chrome (blank
// separators, section headers, the hint line) is dropped progressively.

const KEY_UP    = '\x1b[A';
const KEY_DOWN  = '\x1b[B';
const KEY_ENTER = '\r';
const KEY_ESC   = '\x1b';
const KEY_CTRLC = '\x03';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const SGR_RESET   = '\x1b[0m';
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

/** Printable width of a string, ignoring SGR color sequences. The picker
 *  emits only ASCII plus a few single-cell symbols (▸ ● ◐ ◆ ─ ↑ ↓ ↵ ·), so
 *  char-count equals column-count — no wcwidth table needed. */
function visibleWidth(s: string): number {
  return s.replace(ANSI_SGR_RE, '').length;
}

/** Clip a colored line to `maxCols` terminal cells without splitting SGR
 *  sequences. Clipped lines end in '…' plus a reset so an open color never
 *  bleeds into the next row. */
function truncateAnsi(s: string, maxCols: number): string {
  if (visibleWidth(s) <= maxCols) return s;
  const keep = Math.max(0, maxCols - 1); // leave one cell for the ellipsis
  let out = '';
  let width = 0;
  for (let i = 0; i < s.length; ) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    if (width >= keep) break;
    out += s[i];
    width++;
    i++;
  }
  return out + '…' + SGR_RESET;
}

function renderRow(t: JumpTarget, selected: boolean, idx: number, nameWidth: number, showDetail: boolean): string {
  const cursor = selected ? color.green('▸') : ' ';
  const slot   = color.dim(`[${idx + 1}]`.padStart(4));
  const name   = (selected ? color.bold : color.green)(t.appName.slice(0, nameWidth).padEnd(nameWidth));
  const badge  = typeBadge(t);
  if (t.kind === 'master') {
    // Master row: no instance id or port, just a fixed label so it stands
    // out from the app/service rows that follow.
    const label = showDetail ? ' ' + color.dim('· aura-shell (master container)') : '';
    return `  ${cursor} ${slot} ${name} ${badge}${label}`;
  }
  if (!showDetail) return `  ${cursor} ${slot} ${name} ${badge}`;
  const inst = color.dim(`· ${t.instanceId}`);
  const port = t.port ? ' ' + color.dim(`:${t.port}`) : '';
  return `  ${cursor} ${slot} ${name} ${badge} ${inst}${port}`;
}
/** Badge says what the row IS (HOST / APP / SVC) — more useful at a glance
 *  than the run-state, which is almost always 'resumed'. The state still
 *  shows through glyph + color: green ● running, yellow ◐ paused. It also
 *  keeps app/service rows distinguishable in compact mode when the section
 *  headers are dropped. */
function typeBadge(t: JumpTarget): string {
  if (t.kind === 'master') return color.green('◆ HOST');
  const label = (t.isService ? 'SVC' : 'APP').padEnd(4);
  return t.state === 'paused' ? color.yellow('◐ ' + label) : color.green('● ' + label);
}
function sectionHeader(label: string): string {
  return '  ' + color.dim(`── ${label} ${'─'.repeat(Math.max(0, 40 - label.length))}`);
}

/** Exported for the pty test harness (test-tui/) — not part of the CLI API. */
export async function pickInteractively(targets: JumpTarget[]): Promise<JumpTarget | null> {
  // Default selection: prefer the first app instance (most common case).
  // Fall back to whatever is first in the list — that's MASTER when nothing
  // is running, which is the only reachable target then anyway.
  let idx = targets.findIndex((t) => t.kind === 'instance' && !t.isService);
  if (idx < 0) idx = 0;

  let linesWritten = 0;
  let scrollTop = 0; // first visible body line when the list scrolls

  const draw = (firstTime: boolean) => {
    const rows = stdout.rows || 24;
    const cols = stdout.columns || 80;
    if (!firstTime) {
      // Frames are capped at rows-1 lines, so this normally moves exactly to
      // the top of the previous frame. After a shrink-resize the old frame
      // may be taller than the screen — clamp so we never ask the terminal
      // to move above row 0 (it would silently undershoot and misalign).
      moveCursor(stdout, 0, -Math.min(linesWritten, rows - 1));
      clearScreenDown(stdout);
    }

    // Narrow terminals: shrink the name column and drop the id/port detail
    // before resorting to hard clipping.
    const showDetail = cols >= 60;
    const nameWidth  = Math.max(6, Math.min(14, cols - 22));

    // Body = physical lines (no embedded newlines), each row tagged with its
    // target index so the scroll window can follow the selection.
    // The master row sits on top with no header of its own — the section
    // headers act as separators before the APPS and SERVICES groups.
    // Compactness levels: 0 = blank separators + section headers (the full
    // layout), 1 = headers only, 2 = no headers (the APP/SVC badge keeps the
    // groups distinguishable).
    const buildBody = (level: number): { text: string; target?: number }[] => {
      const body: { text: string; target?: number }[] = [];
      let lastSection = '';
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i]!;
        const section = t.kind === 'master' ? 'MASTER' : t.isService ? 'SERVICES' : 'APPS';
        if (level <= 1 && section !== lastSection) {
          if (section !== 'MASTER') {
            if (level === 0) body.push({ text: '' });
            body.push({ text: sectionHeader(section) });
          }
          lastSection = section;
        }
        body.push({ text: renderRow(t, i === idx, i, nameWidth, showDetail), target: i });
      }
      return body;
    };
    const chromeFor = (level: number): { top: string[]; bottom: string[] } => {
      const title = '  ' + color.bold('AURA  JUMP');
      const hint  = color.dim('  ↑↓ navigate   1–9 quick-pick   ↵ enter   q/^C cancel');
      if (level === 0) return { top: ['', title, hint], bottom: [''] };
      if (level <= 2)  return { top: [title, hint], bottom: [] };
      return { top: [title], bottom: [] }; // level 3: title only
    };

    // Cap every frame at rows-1 lines so the redraw cursor-up move is always
    // valid. Pick the least-compact level whose full frame fits; if even the
    // most compact one doesn't, scroll the body behind ↑/↓ indicators.
    const budget = Math.max(3, rows - 1);
    let lines: string[] | null = null;
    for (let level = 0; level <= 3; level++) {
      const { top, bottom } = chromeFor(level);
      const body = buildBody(level);
      if (top.length + body.length + bottom.length <= budget) {
        lines = [...top, ...body.map((b) => b.text), ...bottom];
        scrollTop = 0;
        break;
      }
    }
    if (!lines) {
      const { top } = chromeFor(3);
      const body = buildBody(3);
      const window = Math.max(1, budget - top.length - 2); // 2 lines reserved for the ↑/↓ indicators
      const selPos = body.findIndex((b) => b.target === idx);
      if (selPos < scrollTop) scrollTop = selPos;
      if (selPos >= scrollTop + window) scrollTop = selPos - window + 1;
      scrollTop = Math.max(0, Math.min(scrollTop, body.length - window));
      const above = scrollTop;
      const below = body.length - (scrollTop + window);
      lines = [
        ...top,
        above > 0 ? color.dim(`    ↑ ${above} more`) : '',
        ...body.slice(scrollTop, scrollTop + window).map((b) => b.text),
        below > 0 ? color.dim(`    ↓ ${below} more`) : '',
      ];
    }

    // Clip to cols-1 so no line can hard-wrap (a wrapped line would occupy
    // two rows and desync linesWritten from the real cursor position).
    const text = lines.map((l) => truncateAnsi(l, Math.max(1, cols - 1))).join('\n') + '\n';
    stdout.write(text);
    linesWritten = lines.length;
  };

  return new Promise<JumpTarget | null>((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdout.write(HIDE_CURSOR);

    const onResize = () => draw(false);

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdout.removeListener('resize', onResize);
      stdout.write(SHOW_CURSOR);
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
    stdout.on('resize', onResize);
    draw(true);
  });
}
