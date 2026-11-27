/**
 * `/data/aura/boot/status.json` (Phase 6 K): the kernel's readiness record,
 * next to `boot/phase` (os/boot.sh). Written atomically (temp file + rename)
 * on every change, so a reader (the updater's probe, diagnose, the Headless
 * test) never sees half a file. Foundation: node only.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BootStatus } from './types.js';

export const BOOTSTRAP_VERSION = 1;

export const bootStatusFile = (dataDir: string): string => join(dataDir, 'aura', 'boot', 'status.json');

export function writeBootStatus(dataDir: string, status: BootStatus): void {
  const file = bootStatusFile(dataDir);
  try {
    mkdirSync(join(dataDir, 'aura', 'boot'), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n', { mode: 0o644 });
    renameSync(tmp, file);
  } catch (err) {
    // A read-only or full /data must not fail the boot; the in-memory status still answers.
    console.warn(`[boot] status.json not written: ${(err as Error).message}`);
  }
}

export function readBootStatus(dataDir: string): BootStatus | null {
  try { return JSON.parse(readFileSync(bootStatusFile(dataDir), 'utf8')) as BootStatus; }
  catch { return null; }
}
