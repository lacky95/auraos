import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A directory only its owner (the shell, root) may enter, such as
 * `<data>/aura/secrets`: created 0700, and repaired to 0700 when it exists
 * with group or other bits (an install whose first writer created it with the
 * default mode). Its parents keep the default mode: a recursive mkdir with
 * `mode` would make every directory it creates, `/data/aura` included, 0700.
 * A leaf: Node built-ins only.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dirname(dir), { recursive: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  } catch { /* the write that follows reports a real problem */ }
}
