// Imported first by identity.test.ts: session and key files resolve to a
// throwaway directory, never a real home or /data.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'aura-cli-identity-'));
process.env['HOME'] = root;
process.env['AURA_DATA_DIR'] = join(root, 'data');
