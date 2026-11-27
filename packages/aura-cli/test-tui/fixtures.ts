// Fabricated picker inputs shared by the pty harnesses (pick-harness.ts,
// prompts-harness.ts) and the golden TUI frames (test/tui-golden.test.ts), so
// the pickers can be exercised at any list length without a live shell.
import type { MultiSelectMode } from '../src/lib/prompts.js';
import { color } from '../src/lib/format.js';

/** `aura jump`'s targets: the master shell plus n instances (every third a long name, the last three services). */
export function pickTargets(n: number): unknown[] {
  const targets: unknown[] = [{ kind: 'master', appName: 'MASTER', state: 'shell' }];
  for (let i = 0; i < n; i++) {
    targets.push({
      kind: 'instance',
      instanceId: `inst-${String(i).padStart(4, '0')}-abcdef012345`,
      appId: `com.test.app${i}`,
      appName: i % 3 === 2 ? `A Very Long Application Name ${i}` : `App${i}`,
      state: i % 4 === 1 ? 'paused' : 'resumed',
      port: 40000 + i,
      isService: i >= n - 3,
      sandbox: 'proot',
    });
  }
  return targets;
}

export const appIds = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `com.test.app${i}${i % 4 === 3 ? '.with-a-rather-long-id' : ''}`);

/** `aura mount`'s single-choice rows. */
export function choiceOptions(n: number): Array<{ value: string; label: string; desc: string }> {
  return appIds(n).map((id, i) => ({
    value: id,
    label: i === 0 ? `${id} ${color.green('[current]')}` : id,
    desc: `Test App ${i} · ${1 + (i % 3)} instances`,
  }));
}

/** `aura mount`'s multi-select rows (colored [self] label, scope/mounted tag, ro/wr radio + data flag). */
export function multiOptions(n: number): MultiSelectMode<string>['options'] {
  return appIds(n).map((id, i) => ({
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
}

export const multiTitle = `Apps mounted into ${color.bold('com.aura.terminal-22')}   ${color.dim('(unchecking detaches)')}`;
export const multiGroups = (options: MultiSelectMode<string>['options']) =>
  [{ label: 'all scopes', options }, { label: 'system', options: options.filter((_, i) => i % 3 === 0) }];
