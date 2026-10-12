// pty test harness for lib/prompts.ts: runs the real promptChoice /
// promptMultiSelect with fabricated rows shaped like `aura mount`'s (colored
// [self] label, scope/mounted tag, ro/wr radio + data flag, descriptions), so
// the pickers can be exercised at any list length without a live shell.
// Usage: tsx prompts-harness.ts <choice|multi> <optionCount>
import { promptChoice, promptMultiSelect, BACK, PromptCancelled, type MultiSelectMode } from '../src/lib/prompts.js';
import { color } from '../src/lib/format.js';

const kind = process.argv[2] ?? 'multi';
const n = parseInt(process.argv[3] ?? '20', 10);
const ids = Array.from({ length: n }, (_, i) => `com.test.app${i}${i % 4 === 3 ? '.with-a-rather-long-id' : ''}`);

async function main(): Promise<unknown> {
  if (kind === 'choice') {
    const r = await promptChoice<string>('Mount into which app?', ids.map((id, i) => ({
      value: id,
      label: i === 0 ? `${id} ${color.green('[current]')}` : id,
      desc: `Test App ${i} · ${1 + (i % 3)} instances`,
    })), 0, { allowBack: true });
    return r === BACK ? 'BACK' : r;
  }
  const options: MultiSelectMode<string>['options'] = ids.map((id, i) => ({
    value: id,
    label: i === 1 ? `${id} ${color.cyan('[self]')}` : id,
    tag: i % 5 === 0 ? color.yellow('mounted') : color.dim(['system', 'global', 'user'][i % 3]!),
    desc: `Test App ${i}`,
    initiallyChecked: i % 5 === 0,
    flags: {
      r: { label: 'ro', group: 'mode', tone: 'dim', initial: true },
      w: { label: 'wr', group: 'mode', tone: 'yellow' },
      d: { label: '+data' },
    },
  }));
  const r = await promptMultiSelect<string>(
    `Apps mounted into ${color.bold('com.aura.terminal-22')}   ${color.dim('(unchecking detaches)')}`,
    [{ label: 'all scopes', options }, { label: 'system', options: options.filter((_, i) => i % 3 === 0) }],
    0, { allowBack: true },
  );
  return r === BACK ? 'BACK' : r.selected.length;
}

main().then(
  (r) => { console.log('RESULT:' + JSON.stringify(r)); process.exit(0); },
  (e) => { console.log('RESULT:' + (e instanceof PromptCancelled ? 'cancelled' : String(e))); process.exit(0); },
);
