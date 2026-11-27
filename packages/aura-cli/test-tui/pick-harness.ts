// pty test harness: runs the real pickInteractively with fabricated targets
// so the picker can be exercised at any list length without live instances.
// Usage: tsx pick-harness.ts <targetCount>
import { pickInteractively } from '../src/commands/jump.js';
import { pickTargets } from './fixtures.js';

const n = parseInt(process.argv[2] ?? '12', 10);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
pickInteractively(pickTargets(n) as any).then((r) => {
  console.log('RESULT:' + JSON.stringify(r === null ? null : (r as { appName: string }).appName));
  process.exit(0);
});
