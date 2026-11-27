// Process and file helpers of the release builder (Phase 6 stream B): the one
// async command runner (the lock heartbeat keeps ticking while it waits) and
// the tree removal for read-only release trees. Shared by builder.mjs and
// gc.mjs. Dependency-free.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Runs a command asynchronously; resolves { code, out }. */
export function run(cmd, args, { env, cwd, input, timeoutMs = 0, onLine, name } = {}) {
  return new Promise((resolve) => {
    let out = '';
    const keep = (d) => {
      const s = d.toString();
      out = (out + s).slice(-64_000);
      if (onLine) for (const l of s.split('\n')) if (l) onLine(l);
    };
    const child = spawn(cmd, args, { env: env ?? process.env, cwd, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    if (input) input(child.stdin);
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        keep(`\n[builder] timed out after ${Math.round(timeoutMs / 1000)} s\n`);
        if (name) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 20_000 });
        child.kill('SIGKILL');
      }, timeoutMs);
    }
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: 127, out: `${out}\n${e.message}` }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, out }); });
  });
}

export const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/** Makes a tree writable again (u+w on dirs and files; symlinks untouched) so it can be removed. */
function makeWritable(p) {
  let st;
  try { st = lstatSync(p); } catch { return; }
  if (st.isSymbolicLink()) return;
  try { chmodSync(p, st.mode | 0o200); } catch { /* best effort */ }
  if (st.isDirectory()) for (const n of readdirSync(p)) makeWritable(join(p, n));
}
export function removeTree(p) {
  if (!existsSync(p)) return;
  makeWritable(p);
  rmSync(p, { recursive: true, force: true });
}
