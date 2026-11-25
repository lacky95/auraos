// Approvals contract (5.10): the payload hash, ids, requester and decider
// projections, and every allowed and refused state transition.
//
// Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/approvals.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  APPROVAL_ACTIONS, APPROVAL_STATES, APPROVAL_TTL_MS, APPROVAL_USES, MAX_PENDING_PER_REQUESTER,
  approvalDecider, approvalRequester, canonicalJson, effectiveApprovalState, isApprovalId,
  newApprovalId, newApprovalRecord, payloadHash, PAYLOAD_HASH_RE, requesterKey, sameRequester,
  transitionApproval, SYSTEM_PRINCIPAL,
} from '../dist/index.js';

const T0 = 1_800_000_000_000;
const TERMINAL = { kind: 'instance', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-3', userId: 'default' };
const OWNER = { kind: 'user', userId: 'default', sessionId: 's1', fresh: false };
const OWNER_FRESH = { ...OWNER, fresh: true };
const OPERATOR = { kind: 'operator' };
const PAYLOAD = { digest: 'sha256:abc', scope: 'user', permissions: ['apps.mount'] };

function record(over = {}) {
  return {
    ...newApprovalRecord({
      requester: TERMINAL, action: 'nexus.install', payloadHash: payloadHash(PAYLOAD),
      display: { title: 'Install Notes', details: ['scope user'], requestedBy: 'Terminal' }, level: 'session',
    }, 'apr_AAAAAAAAAAAAAAAAAAAAAA', T0),
    ...over,
  };
}
const claim = (over = {}) => ({ requester: TERMINAL, action: 'nexus.install', payloadHash: payloadHash(PAYLOAD), ...over });

// ── constants ───────────────────────────────────────────────────────────────

test('single use and a 10-minute expiry', () => {
  assert.equal(APPROVAL_TTL_MS, 600_000);
  assert.equal(APPROVAL_USES, 1);
  assert.equal(MAX_PENDING_PER_REQUESTER, 1);
  assert.deepEqual([...APPROVAL_STATES], ['pending', 'approved', 'denied', 'consumed', 'expired']);
  assert.ok(APPROVAL_ACTIONS.includes('user.confirm'));
  // D50: the owner's management routes, asked for from a sandbox or through Settings.
  for (const a of ['admin.grant', 'admin.revoke', 'admin.api-key', 'admin.manifest-edit', 'admin.read', 'admin.change']) {
    assert.ok(APPROVAL_ACTIONS.includes(a), a);
  }
  const r = record();
  assert.equal(r.state, 'pending');
  assert.equal(r.createdAt, T0);
  assert.equal(r.expiresAt, T0 + APPROVAL_TTL_MS);
  assert.equal(r.decidedBy, undefined);
});

// ── payload hash ────────────────────────────────────────────────────────────

test('canonical JSON sorts keys at every depth and drops undefined members', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: true, y: null }], c: 'x' } }), '{"a":{"c":"x","d":[1,{"y":null,"z":true}]},"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: 2 }), '{"b":2}');
  assert.equal(canonicalJson(Object.assign(Object.create(null), { k: 1 })), '{"k":1}');
  assert.equal(canonicalJson('é\n"'), JSON.stringify('é\n"'));
  assert.equal(canonicalJson(-0), '0');
});

test('the payload hash is SHA-256 hex of the canonical JSON, independent of key order', () => {
  const a = payloadHash({ scope: 'user', digest: 'sha256:abc', permissions: ['x', 'y'] });
  const b = payloadHash({ permissions: ['x', 'y'], digest: 'sha256:abc', scope: 'user' });
  assert.equal(a, b);
  assert.match(a, PAYLOAD_HASH_RE);
  assert.equal(a, createHash('sha256').update('{"digest":"sha256:abc","permissions":["x","y"],"scope":"user"}').digest('hex'));
  assert.notEqual(a, payloadHash({ scope: 'user', digest: 'sha256:abc', permissions: ['y', 'x'] }), 'array order matters');
  assert.notEqual(a, payloadHash({ scope: 'global', digest: 'sha256:abc', permissions: ['x', 'y'] }));
});

test('values JSON cannot carry unchanged are refused', () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const bad of [undefined, NaN, Infinity, 1n, () => 1, Symbol('s'), [undefined], { d: new Date(0) }, new Map(), cyclic]) {
    assert.throws(() => payloadHash(bad), TypeError, String(bad?.toString?.() ?? bad));
  }
  const shared = { x: 1 };
  assert.doesNotThrow(() => canonicalJson({ a: shared, b: shared }), 'a repeated object is not a cycle');
});

// ── ids ─────────────────────────────────────────────────────────────────────

test('approval ids are random and well-formed', () => {
  const a = newApprovalId(); const b = newApprovalId();
  assert.ok(isApprovalId(a) && isApprovalId(b));
  assert.notEqual(a, b);
  for (const bad of ['', 'apr_', 'apr_short', `xyz_${a.slice(4)}`, `${a}x`, 1, null]) assert.equal(isApprovalId(bad), false, String(bad));
});

// ── principals ──────────────────────────────────────────────────────────────

test('requesters: instance (acting for a user), user (also through an app), api key', () => {
  assert.deepEqual(
    approvalRequester({ ...TERMINAL, verification: 'verified', actor: { name: 'claude', verification: 'unverified' } }),
    TERMINAL, 'no unverified actor is kept');
  assert.deepEqual(
    approvalRequester({ kind: 'user', userId: 'default', role: 'owner', sessionId: 's1', verification: 'verified', through: { appId: 'com.aura.nexus', instanceId: 'com.aura.nexus-1' } }),
    { kind: 'user', userId: 'default', through: { appId: 'com.aura.nexus', instanceId: 'com.aura.nexus-1' } }, 'no session id');
  assert.deepEqual(
    approvalRequester({ kind: 'apiKey', keyId: 'k1', name: 'ci', scopes: [], verification: 'verified' }),
    { kind: 'apiKey', keyId: 'k1', name: 'ci' });
  assert.deepEqual(
    approvalRequester({ kind: 'instance', appId: 'a', instanceId: 'a-1', sidecar: 'db', systemId: 'sys', verification: 'verified' }),
    { kind: 'instance', appId: 'a', instanceId: 'a-1', sidecar: 'db', systemId: 'sys' });
});

test('anonymous, system, a retired shared-admin look-alike and the operator cannot request', () => {
  for (const p of [
    { kind: 'anonymous', verification: 'unverified', hints: { appId: 'x' } },
    SYSTEM_PRINCIPAL,
    { kind: 'admin', credential: 'shared', sessionId: 'a', verification: 'verified' },
    { kind: 'operator', verification: 'verified' },
  ]) assert.equal(approvalRequester(p), null, p.kind);
});

test('only a user on the shell itself, or the operator, decides', () => {
  const user = { kind: 'user', userId: 'default', role: 'owner', sessionId: 's1', verification: 'verified' };
  assert.deepEqual(approvalDecider(user), OWNER);
  assert.deepEqual(approvalDecider(user, { fresh: true }), OWNER_FRESH);
  assert.deepEqual(approvalDecider({ kind: 'operator', verification: 'verified' }), OPERATOR);
  for (const p of [
    { ...user, through: { appId: 'com.aura.settings' } },
    { ...TERMINAL, verification: 'verified' },
    { kind: 'apiKey', keyId: 'k1', name: 'ci', scopes: [], verification: 'verified' },
    { kind: 'admin', credential: 'shared', sessionId: 'a', verification: 'verified' },
    { kind: 'anonymous', verification: 'unverified' },
    SYSTEM_PRINCIPAL,
  ]) assert.equal(approvalDecider(p, { fresh: true }), null, `${p.kind}${p.through ? ' through an app' : ''}`);
});

test('requester identity ignores member order but nothing else', () => {
  assert.ok(sameRequester(TERMINAL, { userId: 'default', instanceId: 'com.aura.terminal-3', appId: 'com.aura.terminal', kind: 'instance' }));
  assert.equal(sameRequester(TERMINAL, { ...TERMINAL, instanceId: 'com.aura.terminal-4' }), false);
  assert.equal(sameRequester(TERMINAL, { ...TERMINAL, userId: undefined }), false);
  assert.equal(sameRequester(TERMINAL, { ...TERMINAL, sidecar: 'x' }), false);
  assert.equal(requesterKey(TERMINAL), canonicalJson(TERMINAL));
});

// ── transitions: allowed ────────────────────────────────────────────────────

test('pending → approved by the owner (session level)', () => {
  const r = transitionApproval(record(), { type: 'approve', by: OWNER }, T0 + 1);
  assert.equal(r.ok, true);
  assert.equal(r.record.state, 'approved');
  assert.deepEqual(r.record.decidedBy, OWNER);
});

test('pending → approved at fresh level by a fresh owner or the operator', () => {
  for (const by of [OWNER_FRESH, OPERATOR]) {
    const r = transitionApproval(record({ level: 'fresh' }), { type: 'approve', by }, T0 + 1);
    assert.equal(r.ok && r.record.state, 'approved', by.kind);
  }
});

test('pending → denied', () => {
  const r = transitionApproval(record(), { type: 'deny', by: OWNER }, T0 + 1);
  assert.equal(r.ok && r.record.state, 'denied');
  assert.deepEqual(r.record.decidedBy, OWNER);
});

test('approved → consumed by the exact claim, once', () => {
  const approved = transitionApproval(record(), { type: 'approve', by: OWNER }, T0 + 1).record;
  const consumed = transitionApproval(approved, { type: 'consume', claim: claim() }, T0 + 2);
  assert.equal(consumed.ok && consumed.record.state, 'consumed');
  assert.deepEqual(transitionApproval(consumed.record, { type: 'consume', claim: claim() }, T0 + 3), { ok: false, reason: 'wrong-state' }, 'single use');
});

test('pending or approved → expired at the deadline', () => {
  const approved = transitionApproval(record(), { type: 'approve', by: OWNER }, T0 + 1).record;
  for (const r of [record(), approved]) {
    const out = transitionApproval(r, { type: 'expire' }, T0 + APPROVAL_TTL_MS);
    assert.equal(out.ok && out.record.state, 'expired', r.state);
  }
});

test('transitions never change the input record', () => {
  const r = record();
  const copy = structuredClone(r);
  transitionApproval(r, { type: 'approve', by: OWNER }, T0 + 1);
  transitionApproval(r, { type: 'expire' }, T0 + APPROVAL_TTL_MS);
  assert.deepEqual(r, copy);
});

// ── transitions: refused ────────────────────────────────────────────────────

test('a fresh approval needs a fresh password check', () => {
  assert.deepEqual(transitionApproval(record({ level: 'fresh' }), { type: 'approve', by: OWNER }, T0 + 1), { ok: false, reason: 'needs-fresh-auth' });
});

test('nothing is approved, denied or consumed after the deadline', () => {
  const late = T0 + APPROVAL_TTL_MS;
  const approved = transitionApproval(record(), { type: 'approve', by: OWNER }, T0 + 1).record;
  assert.deepEqual(transitionApproval(record(), { type: 'approve', by: OWNER }, late), { ok: false, reason: 'expired' });
  assert.deepEqual(transitionApproval(record(), { type: 'deny', by: OWNER }, late), { ok: false, reason: 'expired' });
  assert.deepEqual(transitionApproval(approved, { type: 'consume', claim: claim() }, late), { ok: false, reason: 'expired' });
  assert.equal(effectiveApprovalState(record(), late - 1), 'pending');
  assert.equal(effectiveApprovalState(record(), late), 'expired');
  assert.equal(effectiveApprovalState(approved, late), 'expired');
});

test('expire before the deadline, or on a final state, is refused', () => {
  assert.deepEqual(transitionApproval(record(), { type: 'expire' }, T0 + APPROVAL_TTL_MS - 1), { ok: false, reason: 'wrong-state' });
  for (const state of ['denied', 'consumed', 'expired']) {
    assert.deepEqual(transitionApproval(record({ state }), { type: 'expire' }, T0 + APPROVAL_TTL_MS + 1), { ok: false, reason: 'wrong-state' }, state);
    assert.equal(effectiveApprovalState(record({ state }), T0 + APPROVAL_TTL_MS + 1), state, 'final states stay');
  }
});

test('a pending record cannot be consumed', () => {
  assert.deepEqual(transitionApproval(record(), { type: 'consume', claim: claim() }, T0 + 1), { ok: false, reason: 'wrong-state' });
});

test('an approved record cannot be approved or denied again', () => {
  const approved = transitionApproval(record(), { type: 'approve', by: OWNER }, T0 + 1).record;
  assert.deepEqual(transitionApproval(approved, { type: 'approve', by: OWNER }, T0 + 2), { ok: false, reason: 'wrong-state' });
  assert.deepEqual(transitionApproval(approved, { type: 'deny', by: OWNER }, T0 + 2), { ok: false, reason: 'wrong-state' });
});

test('final states accept no event', () => {
  for (const state of ['denied', 'consumed', 'expired']) {
    const r = record({ state, decidedBy: OWNER });
    for (const ev of [{ type: 'approve', by: OWNER_FRESH }, { type: 'deny', by: OWNER }, { type: 'consume', claim: claim() }]) {
      const out = transitionApproval(r, ev, T0 + 1);
      assert.equal(out.ok, false, `${state} + ${ev.type}`);
      assert.equal(out.reason, state === 'expired' ? 'expired' : 'wrong-state', `${state} + ${ev.type}`);
    }
  }
});

test('consume binds requester, action and payload hash', () => {
  const approved = transitionApproval(record(), { type: 'approve', by: OWNER }, T0 + 1).record;
  for (const [what, c] of [
    ['another instance', claim({ requester: { ...TERMINAL, instanceId: 'com.aura.terminal-9' } })],
    ['another app', claim({ requester: { kind: 'instance', appId: 'com.example.counter', instanceId: 'com.example.counter-1', userId: 'default' } })],
    ['the owner directly', claim({ requester: { kind: 'user', userId: 'default' } })],
    ['another action', claim({ action: 'nexus.update' })],
    ['another payload (a moved tag)', claim({ payloadHash: payloadHash({ ...PAYLOAD, digest: 'sha256:def' }) })],
  ]) {
    assert.deepEqual(transitionApproval(approved, { type: 'consume', claim: c }, T0 + 2), { ok: false, reason: 'mismatch' }, what);
  }
});

test('an unknown event is refused', () => {
  assert.deepEqual(transitionApproval(record(), { type: 'nope' }, T0 + 1), { ok: false, reason: 'wrong-state' });
});
