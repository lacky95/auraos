// The atomic-switch helper for tests (os/rename-exchange, Phase 7a): built
// from the repo's source with the same flags as the Dockerfile, once per
// source hash, into the OS temp dir. The image ships it at
// /os/rename-exchange/aura-rename-exchange; tests pass this copy to the
// Installer / NexusManager (`exchangeHelper`).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'os', 'rename-exchange', 'rename-exchange.c');

export function exchangeHelper() {
  const hash = createHash('sha256').update(readFileSync(SRC)).digest('hex').slice(0, 16);
  const dir = join(tmpdir(), 'aura-test-rename-exchange');
  const bin = join(dir, `aura-rename-exchange-${hash}`);
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  const tmp = `${bin}.${process.pid}`;
  execFileSync('cc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', tmp, SRC], { stdio: ['ignore', 'pipe', 'pipe'] });
  renameSync(tmp, bin);
  return bin;
}
