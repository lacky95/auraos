// D109 AF3: the TUI frames of the human CLI are golden (the Addendum's
// byte-identity baseline): the `aura jump` picker and the `aura mount` /
// `aura dev new` pickers (lib/prompts.ts), driven with the pty harnesses'
// fixtures (test-tui/fixtures.ts) through a fake terminal of 80x24. Every
// byte the TUI writes is compared, escape sequences included.
//
//   pnpm --filter @aura/cli test     (AURA_UPDATE_GOLDEN=1 rewrites test/golden/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pickInteractively } from '../src/commands/jump.js';
import { PromptCancelled, promptChoice, promptMultiSelect } from '../src/lib/prompts.js';
import { choiceOptions, multiGroups, multiOptions, multiTitle, pickTargets } from '../test-tui/fixtures.js';
import { assertGolden } from './helpers/golden.js';

/**
 * A terminal for one TUI run: keys in through a fake stdin, every byte the TUI writes recorded by a fake
 * stdout. Both replace `process.stdin` / `process.stdout` for the run (the CLI reads them from `node:process`
 * at each use); node:test keeps its own reference to the real stdout, so its reporter protocol never lands in
 * a frame, and nothing in a frame depends on the worktree path.
 */
async function drive(run: () => Promise<unknown>, keys: string[]): Promise<{ frames: string[]; result: unknown }> {
  const fakeIn = Object.assign(new EventEmitter(), {
    isTTY: true, setRawMode() { return fakeIn; }, resume() { return fakeIn; }, pause() { return fakeIn; }, setEncoding() { return fakeIn; },
  });
  let buf = '';
  const fakeOut = Object.assign(new EventEmitter(), {
    isTTY: true, columns: 80, rows: 24,
    write(chunk: string | Uint8Array, ...rest: unknown[]) {
      buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      const cb = rest.find((x) => typeof x === 'function') as (() => void) | undefined;
      cb?.();
      return true;
    },
    // node:readline's cursor helpers (moveCursor, clearScreenDown) only call write().
  });
  const saved = { stdin: Object.getOwnPropertyDescriptor(process, 'stdin')!, stdout: Object.getOwnPropertyDescriptor(process, 'stdout')! };
  const frames: string[] = [];
  const tick = () => new Promise((r) => setImmediate(r));
  Object.defineProperty(process, 'stdin', { value: fakeIn, configurable: true, writable: true });
  Object.defineProperty(process, 'stdout', { value: fakeOut, configurable: true, writable: true });
  let result: unknown;
  try {
    const done = run().then((r) => { result = r; }, (e) => { result = e instanceof PromptCancelled ? 'cancelled' : String(e); });
    await tick();
    frames.push(buf); buf = '';
    for (const k of keys) {
      fakeIn.emit('data', k);
      await tick();
      frames.push(buf); buf = '';
    }
    await done;
  } finally {
    Object.defineProperty(process, 'stdin', saved.stdin);
    Object.defineProperty(process, 'stdout', saved.stdout);
  }
  return { frames, result };
}

const DOWN = '\x1b[B';
const CTRL_C = '\x03';

test('golden: TUI frames of the jump picker, the choice and the multi-select pickers', async () => {
  const frames: Record<string, string> = {};
  const record = (name: string, r: { frames: string[]; result: unknown }) => {
    r.frames.forEach((f, i) => { frames[`${name} #${i}`] = f; });
    frames[`${name} result`] = JSON.stringify(r.result ?? null);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pick = await drive(() => pickInteractively(pickTargets(12) as any), [DOWN, DOWN, 'q']);
  assert.equal(pick.result, null, 'q quits the picker');
  record('jump picker (12 targets)', pick);

  const choice = await drive(() => promptChoice<string>('Mount into which app?', choiceOptions(8), 0, { allowBack: true }), [DOWN, CTRL_C]);
  assert.equal(choice.result, 'cancelled');
  record('choice (8 options)', choice);

  const multi = await drive(() => promptMultiSelect<string>(multiTitle, multiGroups(multiOptions(8)), 0, { allowBack: true }), [DOWN, ' ', CTRL_C]);
  assert.equal(multi.result, 'cancelled');
  record('multi-select (8 options)', multi);

  for (const [k, v] of Object.entries(frames)) {
    if (k.endsWith('result')) continue;
    assert.ok(v.length > 0, `${k} drew nothing`);
    // Only the picker's bytes: no test-runner protocol, no path of the checkout it runs in.
    assert.doesNotMatch(v, /test:(enqueue|dequeue|start|pass|fail|plan|diagnostic)|\/data\/|\.test\.(ts|cjs|mjs)|node:test/, `${k} holds runner output`);
  }
  assertGolden('tui-frames.json', frames);
});
