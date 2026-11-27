// The CLI's one reader of AuraOS's error body (error-messages review Pass A):
// readable refusals (what, why, the fix), exit codes, and JSON errors with
// -o json. A body without a message keeps the old output.
//
//   pnpm --filter @aura/cli test
import './helpers/isolated-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT, errorBodyOf, errorJson, exitCodeOf, formatShellError, shellErrorText, wantsJsonErrors, type ShellError,
} from '../src/lib/client.js';

const refusal = JSON.stringify({
  error: 'access-denied', reason: 'missing-target-permission', category: 'missing-permission',
  message: "com.example.notes has to hold 'apps.mount' for this call, and does not.",
  hint: 'Add "apps.mount" to permissions[] in app.manifest.json, or the owner adds it: aura grant perms com.example.notes apps.mount.',
  permission: 'apps.mount', holder: 'target',
});

test('a structured refusal reads as what, why and the fix', () => {
  assert.equal(formatShellError('POST', '/api/instances/x/mounts', 403, refusal), [
    'POST /api/instances/x/mounts: refused (403 access-denied · missing-target-permission)',
    "  com.example.notes has to hold 'apps.mount' for this call, and does not.",
    '  Fix: Add "apps.mount" to permissions[] in app.manifest.json, or the owner adds it: aura grant perms com.example.notes apps.mount.',
  ].join('\n'));
  // A failure that is not a refusal, with a code and a message, no hint.
  assert.equal(formatShellError('GET', '/api/x', 409, JSON.stringify({ error: 'conflict', message: 'Already running.' })),
    'GET /api/x: failed (409 conflict)\n  Already running.');
  // Prose in `error` (the old errorResponse): the sentence, no code label.
  assert.equal(formatShellError('GET', '/api/x', 500, JSON.stringify({ error: 'disk is full' })), 'GET /api/x: failed (500)\n  disk is full');
});

test('a body without a message keeps the old output', () => {
  assert.equal(formatShellError('GET', '/api/x', 403, '{"error":"gateway-denied"}'), 'GET /api/x failed with 403: {"error":"gateway-denied"}');
  assert.equal(formatShellError('GET', '/api/x', 502, 'Bad Gateway'), 'GET /api/x failed with 502: Bad Gateway');
  assert.equal(formatShellError('GET', '/api/admin/x', 403, '{"error":"access-denied"}', 'Run it as the owner.'),
    'GET /api/admin/x failed with 403: {"error":"access-denied"}\n  Run it as the owner.');
});

test('the CLI\'s own hint for owner routes shows only when the server sent none', () => {
  const withServerHint = formatShellError('POST', '/api/admin/grants', 403, refusal, 'Run it in the System Terminal.');
  assert.doesNotMatch(withServerHint, /System Terminal/);
  const noServerHint = formatShellError('POST', '/api/admin/grants', 403,
    JSON.stringify({ error: 'access-denied', reason: 'wrong-principal', message: "This is the owner's action: apps cannot be granted it." }),
    'Run it in the System Terminal.');
  assert.match(noServerHint, /Fix: Run it in the System Terminal\./);
});

test('the short form for commands that name the subject (mount, port, clone)', () => {
  const e = Object.assign(new Error('x'), { status: 403, body: refusal }) as ShellError;
  assert.equal(shellErrorText(e),
    "com.example.notes has to hold 'apps.mount' for this call, and does not. (HTTP 403 access-denied · missing-target-permission)\n"
    + '  Fix: Add "apps.mount" to permissions[] in app.manifest.json, or the owner adds it: aura grant perms com.example.notes apps.mount.');
  // Older bodies: the code or sentence, as the three copies did; raw text; no body.
  assert.equal(shellErrorText(Object.assign(new Error('x'), { status: 404, body: '{"error":"not-found"}' })), 'not-found (HTTP 404)');
  assert.equal(shellErrorText(Object.assign(new Error('x'), { status: 502, body: 'Bad Gateway' })), 'HTTP 502: Bad Gateway');
  assert.equal(shellErrorText(new Error('Cannot reach AuraOS shell')), 'Cannot reach AuraOS shell');
});

test('exit codes: 3 refused, 4 not found, 5 not approved, 1 anything else', () => {
  const e = (status?: number, exitCode?: number) => Object.assign(new Error('x'), { status, ...(exitCode ? { exitCode } : {}) });
  assert.equal(exitCodeOf(e(401)), EXIT.refused);
  assert.equal(exitCodeOf(e(403)), 3);
  assert.equal(exitCodeOf(e(404)), 4);
  assert.equal(exitCodeOf(e(500)), 1);
  assert.equal(exitCodeOf(e(202, EXIT.notApproved)), 5);
  assert.equal(exitCodeOf(new Error('plain')), 1);
  assert.equal(exitCodeOf('string thrown'), 1);
});

test('-o json / --json: errors as one JSON object with the code, the facts and the status', () => {
  for (const argv of [['get', 'apps', '-o', 'json'], ['-ojson'], ['--output=json'], ['--output', 'json'], ['--json']]) {
    assert.equal(wantsJsonErrors(argv), true, argv.join(' '));
  }
  for (const argv of [['get', 'apps'], ['-o', 'yaml'], ['--output', 'wide'], ['json']]) assert.equal(wantsJsonErrors(argv), false, argv.join(' '));
  const shell = Object.assign(new Error('formatted'), { status: 403, body: refusal, data: errorBodyOf(refusal)! }) as ShellError;
  const out = JSON.parse(errorJson(shell)) as Record<string, unknown>;
  assert.equal(out['error'], 'access-denied');
  assert.equal(out['reason'], 'missing-target-permission');
  assert.equal(out['permission'], 'apps.mount');
  assert.equal(out['status'], 403);
  assert.match(String(out['message']), /has to hold 'apps\.mount'/);
  assert.deepEqual(JSON.parse(errorJson(new Error('boom'))), { error: 'cli-error', message: 'boom' });
});
