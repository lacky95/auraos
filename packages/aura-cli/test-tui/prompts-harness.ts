// pty test harness for lib/prompts.ts: runs the real promptChoice /
// promptMultiSelect with fabricated rows shaped like `aura mount`'s (colored
// [self] label, scope/mounted tag, ro/wr radio + data flag, descriptions), so
// the pickers can be exercised at any list length without a live shell.
// Usage: tsx prompts-harness.ts <choice|multi> <optionCount>
import { promptChoice, promptMultiSelect, BACK, PromptCancelled } from '../src/lib/prompts.js';
import { choiceOptions, multiGroups, multiOptions, multiTitle } from './fixtures.js';

const kind = process.argv[2] ?? 'multi';
const n = parseInt(process.argv[3] ?? '20', 10);

async function main(): Promise<unknown> {
  if (kind === 'choice') {
    const r = await promptChoice<string>('Mount into which app?', choiceOptions(n), 0, { allowBack: true });
    return r === BACK ? 'BACK' : r;
  }
  const r = await promptMultiSelect<string>(multiTitle, multiGroups(multiOptions(n)), 0, { allowBack: true });
  return r === BACK ? 'BACK' : r.selected.length;
}

main().then(
  (r) => { console.log('RESULT:' + JSON.stringify(r)); process.exit(0); },
  (e) => { console.log('RESULT:' + (e instanceof PromptCancelled ? 'cancelled' : String(e))); process.exit(0); },
);
