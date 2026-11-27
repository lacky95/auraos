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

/** A terminal for one TUI run: keys in through a fake stdin, every byte out of stdout recorded. */
async function drive(run: () => Promise<unknown>, keys: string[]): Promise<{ frames: string[]; result: unknown }> {
  const fake = Object.assign(new EventEmitter(), {
    isTTY: true, setRawMode() { return fake; }, resume() { return fake; }, pause() { return fake; }, setEncoding() { return fake; },
  });
  const stdinDesc = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  const out = process.stdout as NodeJS.WriteStream & { isTTY: boolean };
  const saved = { write: out.write, isTTY: out.isTTY, columns: out.columns, rows: out.rows };
  let buf = '';
  const frames: string[] = [];
  const tick = () => new Promise((r) => setImmediate(r));
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true, writable: true });
  Object.assign(out, { isTTY: true, columns: 80, rows: 24 });
  out.write = ((chunk: string | Uint8Array) => { buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; }) as typeof out.write;
  let result: unknown;
  try {
    const done = run().then((r) => { result = r; }, (e) => { result = e instanceof PromptCancelled ? 'cancelled' : String(e); });
    await tick();
    frames.push(buf); buf = '';
    for (const k of keys) {
      fake.emit('data', k);
      await tick();
      frames.push(buf); buf = '';
    }
    await done;
  } finally {
    out.write = saved.write;
    Object.assign(out, { isTTY: saved.isTTY, columns: saved.columns, rows: saved.rows });
    Object.defineProperty(process, 'stdin', stdinDesc);
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

  for (const [k, v] of Object.entries(frames)) if (!k.endsWith('result')) assert.ok(v.length > 0, `${k} drew nothing`);
  assertGolden('tui-frames.json', frames);
});
