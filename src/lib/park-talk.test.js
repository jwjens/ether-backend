'use strict';
// node --test src/lib/park-talk.test.js — Park mic: warm lines, the floor, the relay's checks — under the standing rule
// (Jeff, 2026-10-16): the user is in charge of on and off; nothing here ends a talk by itself.
const test = require('node:test');
const assert = require('node:assert');
const { TalkBook, warmPathOf, WARM_TTL_MS, RENEW_EVERY_MS } = require('./park-talk');

const mk = () => { let t = 1_000_000, n = 0; const b = new TalkBook({ now: () => t, random: () => `${(++n).toString(16)}`.padStart(16, 'a').padEnd(48, 'f') }); return { b, tick: (ms) => { t += ms; } }; };

test('a warm line: the phone publishes with its ticket, the station reads with its token, only on its own path', () => {
  const { b } = mk();
  const w = b.warm('S', 'sessA');
  assert.strictEqual(b.canPublish(warmPathOf('S', w.warmId), w.ticket), true);
  assert.strictEqual(b.canPublish(warmPathOf('S', w.warmId), w.readToken), false);
  assert.strictEqual(b.canRead(warmPathOf('S', w.warmId), w.readToken), true);
  assert.strictEqual(b.canRead(warmPathOf('OTHER', w.warmId), w.readToken), false);
});

test('one talker per Park mic: another phone is busy and named; the other mic is free', () => {
  const { b } = mk();
  const a = b.warm('S', 'sessA'), c = b.warm('S', 'sessB');
  assert.strictEqual(b.open('S', 1, 'sessA', 'Ryan', a.warmId).ok, true);
  assert.deepStrictEqual(b.open('S', 1, 'sessB', 'Maria', c.warmId), { ok: false, busy: true, by: 'Ryan' });
  assert.strictEqual(b.open('S', 2, 'sessB', 'Maria', c.warmId).ok, true);
  assert.strictEqual(b.open('S', 1, 'sessB', 'Maria', 'nope').ok, false);   // a line that isn't this phone's
});

test('NEVER ends by itself: an hour with no renewals, the talk and its line are still there', () => {
  const { b, tick } = mk();
  const a = b.warm('S', 'sessA');
  b.open('S', 1, 'sessA', 'Ryan', a.warmId);
  tick(60 * 60 * 1000);
  assert.deepStrictEqual(b.sweep(), []);
  assert.strictEqual(b.state('S')[1].by, 'Ryan');
  assert.strictEqual(b.canRead(warmPathOf('S', a.warmId), a.readToken), true);
  assert.strictEqual(b.warmClose(a.ticket).kept, 'in a talk');            // turning the mic off never ends a talk
});

test('only the talker (tap off) or the station (STOP, lock) ends a talk', () => {
  const { b } = mk();
  const a = b.warm('S', 'sessA');
  b.open('S', 1, 'sessA', 'Ryan', a.warmId);
  assert.strictEqual(b.close('S', 1, 'sessB').ok, false);                 // someone else cannot
  assert.strictEqual(b.close('S', 1, 'sessA').ok, true);
  b.open('S', 1, 'sessA', 'Ryan', a.warmId);
  assert.strictEqual(b.endedByStation('S', 1), true);
  assert.strictEqual(b.state('S')[1], null);
});

test('a line nobody talks on lapses when its phone stops renewing; renewals re-tell the station at most every RENEW_EVERY_MS', () => {
  const { b, tick } = mk();
  const a = b.warm('S', 'sessA');
  tick(5000); assert.strictEqual(b.warmRenew(a.ticket, 'sessA').tellStation, false);
  tick(RENEW_EVERY_MS); assert.strictEqual(b.warmRenew(a.ticket, 'sessA').tellStation, true);
  assert.strictEqual(b.warmRenew(a.ticket, 'sessB').ok, false);
  tick(WARM_TTL_MS + 1);
  assert.deepStrictEqual(b.sweep(), [{ station: 'S', warmId: a.warmId }]);
});
