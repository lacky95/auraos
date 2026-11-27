// node:test reporter used by tools/run-tests.mjs: appends the file of every
// reported test to AURA_TEST_FILE_LOG synchronously, so the record survives
// --test-force-exit cutting the run short. The runner compares it with the
// test files the suite script names (D95: never silently skip tests).
import { appendFileSync } from 'node:fs';

export default async function* reporter(source) {
  for await (const e of source) {
    // node reports a test file that registered no test as one passing test named after the file.
    if (e.type === 'test:pass' && e.data.file && e.data.file.endsWith(e.data.name)) continue;
    if ((e.type === 'test:pass' || e.type === 'test:fail') && e.data.file && e.data.details?.type !== 'suite') {
      appendFileSync(process.env.AURA_TEST_FILE_LOG, `${e.data.file}\n`);
    }
  }
}
