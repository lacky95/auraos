// pty test harness: runs the real pickInteractively with fabricated targets
// so the picker can be exercised at any list length without live instances.
// Usage: tsx pick-harness.ts <targetCount>
import { pickInteractively } from '../src/commands/jump.js';

const n = parseInt(process.argv[2] ?? '12', 10);
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
pickInteractively(targets as any).then((r) => {
  console.log('RESULT:' + JSON.stringify(r === null ? null : (r as { appName: string }).appName));
  process.exit(0);
});
