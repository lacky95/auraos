// Tests for sidecars that survive an instance restart (app-manager/sidecarParking.ts).
// Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/sidecar-parking.test.mjs
//
// Background: every app restart removed the app's sidecars (reapSiblingsOf on
// stop), so io.lakner.teams' Steel Chrome relaunched and Teams was down ~2 min.
// Sidecars labelled aura.keep-restart=1 are now parked on a restart/crash and
// adopted by the instance when it is back; an explicit stop/kill still reaps.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SidecarParking, DEFAULT_RESTART_GRACE_MS, KEEP_RESTART_LABEL, keepServicesOf, keptAcrossRestart,
} from '../dist/app-manager/sidecarParking.js';

const clock = (t0 = 1_000_000) => { let t = t0; const now = () => t; now.advance = (ms) => { t += ms; }; return now; };

test('label name is stable (the SDK writes it)', () => {
  assert.equal(KEEP_RESTART_LABEL, 'aura.keep-restart');
});

test('a parked instance stays parked within its grace', () => {
  const now = clock();
  const p = new SidecarParking(now);
  p.park('io.example.app');
  assert.equal(p.isParked('io.example.app'), true);
  now.advance(DEFAULT_RESTART_GRACE_MS - 1);
  assert.equal(p.isParked('io.example.app'), true);
  assert.deepEqual(p.takeExpired(), []);
});

test('coming back unparks (sidecars were adopted, nothing to reap)', () => {
  const now = clock();
  const p = new SidecarParking(now);
  p.park('io.example.app');
  assert.equal(p.unpark('io.example.app'), true);
  assert.equal(p.isParked('io.example.app'), false);
  now.advance(DEFAULT_RESTART_GRACE_MS * 2);
  assert.deepEqual(p.takeExpired(), [], 'an unparked instance never expires into a reap');
  assert.equal(p.unpark('io.example.app'), false, 'unpark is idempotent');
});

test('not back within the grace: expires once, for the reaper', () => {
  const now = clock();
  const p = new SidecarParking(now);
  p.park('a', 1000);
  p.park('b', 5000);
  now.advance(1000);
  assert.equal(p.isParked('a'), false, 'deadline reached counts as expired');
  assert.deepEqual(p.takeExpired(), ['a']);
  assert.deepEqual(p.takeExpired(), [], 'taken only once');
  assert.equal(p.isParked('b'), true);
  now.advance(4000);
  assert.deepEqual(p.takeExpired(), ['b']);
  assert.deepEqual(p.list(), []);
});

test('parking again restarts the grace (a restart right after a crash)', () => {
  const now = clock();
  const p = new SidecarParking(now);
  p.park('a', 1000);
  now.advance(900);
  p.park('a', 1000);
  now.advance(900);
  assert.equal(p.isParked('a'), true);
  assert.deepEqual(p.list().map((x) => x.instanceId), ['a']);
});

test('manifest services opt in by keepAcrossRestart', () => {
  assert.deepEqual(keepServicesOf({ services: [
    { name: 'steel', keepAcrossRestart: true }, { name: 'db' }, { name: 'cache', keepAcrossRestart: false },
  ] }), ['steel']);
  assert.deepEqual(keepServicesOf(null), []);
  assert.deepEqual(keepServicesOf({}), []);
});

test('a container is kept by its label or by its service name (older SDKs set only aura.service)', () => {
  const keep = { services: ['steel'] };
  assert.equal(keptAcrossRestart('1', 'other', keep), true, 'label wins');
  assert.equal(keptAcrossRestart('', 'steel', keep), true, 'service named in the manifest');
  assert.equal(keptAcrossRestart(undefined, 'db', keep), false);
  assert.equal(keptAcrossRestart('', '', { services: [] }), false);
});
