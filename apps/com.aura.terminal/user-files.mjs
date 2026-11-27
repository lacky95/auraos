// The user's own files, run AS the session user (stream T2): the Terminal
// server (the service uid) starts `node user-files.mjs <op>` through the
// session launcher (src/user-files.ts). Input: JSON on stdin; output: one JSON
// line, { ok, value } or { ok: false, error }. The operations are
// src/user-file-ops.ts (agent hooks, quick commands), loaded from source.
const { USER_FILE_OPS, isUserFileOp } = await import('./src/user-file-ops.ts');
const op = process.argv[2] ?? '';
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  if (!isUserFileOp(op)) throw new Error(`unknown operation ${op}`);
  const value = await USER_FILE_OPS[op](input.trim() ? JSON.parse(input) : undefined);
  process.stdout.write(JSON.stringify({ ok: true, value }) + '\n');
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: err?.message ?? String(err) }) + '\n');
}
