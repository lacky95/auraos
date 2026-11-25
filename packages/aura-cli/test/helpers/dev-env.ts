// Imported first by dev-patch.test.ts (before the CLI modules read their env
// at load): a throwaway home, data dir and patch-repo root, and THIS
// checkout's app template — never the live /workspace one.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'aura-cli-dev-'));
process.env['HOME'] = root;
process.env['AURA_DATA_DIR'] = join(root, 'data');
process.env['AURA_PATCHES_DIR'] = join(root, 'patches');
// The bundle runs from packages/aura-cli/.test-dist.
process.env['AURA_TEMPLATE_DIR'] = join(__dirname, '..', 'src', 'templates', 'app');
process.env['GIT_AUTHOR_NAME'] = 'Test';
process.env['GIT_AUTHOR_EMAIL'] = 'test@example.com';
process.env['GIT_COMMITTER_NAME'] = 'Test';
process.env['GIT_COMMITTER_EMAIL'] = 'test@example.com';
export const TEST_ROOT = root;
