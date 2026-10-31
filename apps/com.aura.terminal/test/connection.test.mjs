// The redial policy: backoff on drops, instant on wake-ups, never two live
// sockets at once, and no "[disconnected]" notice for a sub-second blip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, NOTICE_MS, SUPERSEDE_WAIT_MS } from '../src/connection.ts';

function harness({ detached = false } = {}) {
  let t = 0;
  const timers = new Set();
  const log = [];
  let socketState = 'none';          // none | connecting | open | closed
  const c = createConnection({
    dial: () => { socketState = 'connecting'; log.push(['dial', t]); },
    closeCurrent: () => {
      if (socketState === 'connecting' || socketState === 'open') { socketState = 'closing'; log.push(['close', t]); return true; }
      return false;
    },
    healthy: () => socketState === 'connecting' || socketState === 'open',
    detached: () => detached,
    onOutage: () => log.push(['outage', t]),
    now: () => t,
    setTimer: (cb, ms) => { const h = { cb, at: t + ms }; timers.add(h); return h; },
    clearTimer: (h) => timers.delete(h),
  });
  const advance = (ms) => {
    const target = t + ms;
    for (;;) {
      const next = [...timers].filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.delete(next); t = next.at; next.cb();
    }
    t = target;
  };
  const dials = () => log.filter((e) => e[0] === 'dial').map((e) => e[1]);
  return {
    c, log, advance, dials,
    open() { socketState = 'open'; c.opened(); },
    drop({ wasOpen = true } = {}) { socketState = 'closed'; c.closed({ current: true, wasOpen }); },
    supersededClosed() { c.closed({ current: false, wasOpen: true }); },
    state: () => socketState,
  };
}

test('a drop retries on the 500 ms · 2ⁿ ladder, capped at 10 s', () => {
  const h = harness();
  h.c.connect();
  h.open();
  // The first retry after a drop and the first after a failed dial are both 500 ms.
  const expected = [500, 500, 1000, 2000, 4000, 8000, 10000, 10000];
  let last = 0;
  h.drop();
  for (const gap of expected) {
    h.advance(gap - 1);
    assert.equal(h.dials().length, last + 1, `no dial before ${gap} ms`);
    h.advance(1);
    assert.equal(h.dials().length, last + 2, `dial at ${gap} ms`);
    last++;
    h.drop({ wasOpen: false });
  }
});

test('opening resets the ladder', () => {
  const h = harness();
  h.c.connect(); h.open();
  h.drop(); h.advance(500); h.drop({ wasOpen: false }); h.advance(1000);
  h.open();
  h.drop();
  const before = h.dials().length;
  h.advance(500);
  assert.equal(h.dials().length, before + 1, 'back to 500 ms');
});

test('a wake-up redials now and cancels the pending retry', () => {
  const h = harness();
  h.c.connect(); h.open();
  h.drop();                                   // retry armed for +500
  h.advance(100);
  h.c.wake();
  assert.deepEqual(h.dials(), [0, 100]);
  h.advance(2000);
  assert.equal(h.dials().length, 2, 'the old retry did not fire as well');
});

test('a wake-up while healthy does nothing', () => {
  const h = harness();
  h.c.connect(); h.open();
  h.c.wake();
  assert.equal(h.dials().length, 1);
});

test('redialling over a live socket waits for it to close first', () => {
  const h = harness();
  h.c.connect(); h.open();
  h.c.connect();                              // e.g. a session switch
  assert.equal(h.dials().length, 1, 'not yet — the old socket is still open');
  assert.equal(h.log.at(-1)[0], 'close');
  h.supersededClosed();
  assert.equal(h.dials().length, 2, 'dialled as soon as the old one closed');
  h.advance(SUPERSEDE_WAIT_MS + 1);
  assert.equal(h.dials().length, 2, 'the fallback did not dial a third time');
});

test('…or after the fallback wait if the close never reports', () => {
  const h = harness();
  h.c.connect(); h.open();
  h.c.connect();
  h.advance(SUPERSEDE_WAIT_MS);
  assert.equal(h.dials().length, 2);
});

test('the outage notice waits NOTICE_MS; a quick reconnect stays silent', () => {
  const quick = harness();
  quick.c.connect(); quick.open();
  quick.drop();
  quick.advance(500);                         // retry dials
  quick.open();                               // …and is up again within the second
  quick.advance(5000);
  assert.ok(!quick.log.some((e) => e[0] === 'outage'));

  const slow = harness();
  slow.c.connect(); slow.open();
  slow.drop();
  slow.advance(NOTICE_MS);
  assert.ok(slow.log.some((e) => e[0] === 'outage'));
  assert.equal(slow.c.outage(), true);
  slow.drop({ wasOpen: false });
  slow.advance(NOTICE_MS * 2);
  assert.equal(slow.log.filter((e) => e[0] === 'outage').length, 1, 'announced once per outage');
});

test('the tick redials a dead socket only when nothing is pending', () => {
  const h = harness();
  h.c.connect(); h.open();
  h.drop();
  h.c.tick();
  assert.equal(h.dials().length, 1, 'a retry is pending: tick stays out of it');
  h.advance(500);
  h.drop({ wasOpen: false });
  h.c.stop();                                 // simulate a lost close event: no retry armed
  h.c.tick();
  assert.equal(h.dials().length, 3);
});

test('detached: no dial, no retry, no notice', () => {
  const h = harness({ detached: true });
  h.c.connect();
  h.c.wake();
  h.c.tick();
  h.c.closed({ current: true, wasOpen: true });
  h.advance(20_000);
  assert.deepEqual(h.log, []);
});
