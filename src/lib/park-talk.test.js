'use strict';
// node --test src/lib/park-talk.test.js — Hold to talk: one talker per Park mic, tickets, the station's start/stop, the
// relay's checks, the longest talk, a vanished phone.
const test = require('node:test');
const assert = require('node:assert');
const { TalkBook, pathOf, TICKET_TTL_MS, RENEW_EVERY_MS } = require('./park-talk');

const mk = () => { let t = 1_000_000, n = 0; const b = new TalkBook({ now: () => t, random: () => `r${++n}`.padEnd(20, 'x') }); return { b, tick: (ms) => { t += ms; } }; };

test('one talker per Park mic: a second press is busy and named; the other mic is free', () => {
  const { b } = mk();
  const a = b.open('S', 1, 'sessA', 'Ryan');
  assert.strictEqual(a.ok, true); assert.strictEqual(a.tellStation, true);
  assert.deepStrictEqual(b.open('S', 1, 'sessB', 'Maria'), { ok: false, busy: true, by: 'Ryan' });
  assert.strictEqual(b.open('S', 2, 'sessB', 'Maria').ok, true);
  assert.deepStrictEqual(Object.keys(b.state('S')), ['1', '2']);
  assert.strictEqual(b.state('S')[1].by, 'Ryan');
  assert.strictEqual(b.open('S', 3, 'sessB', 'Maria').ok, false);
});

test('the relay: the phone publishes with its ticket, the station reads with its token, only on that mic', () => {
  const { b } = mk();
  const a = b.open('S', 1, 'sessA', 'Ryan');
  assert.strictEqual(b.canPublish(pathOf('S', 1), a.ticket), true);
  assert.strictEqual(b.canPublish(pathOf('S', 2), a.ticket), false);
  assert.strictEqual(b.canPublish(pathOf('S', 1), a.readToken), false);
  assert.strictEqual(b.canRead(pathOf('S', 1), a.readToken), true);
  assert.strictEqual(b.canRead(pathOf('S', 1), a.ticket), false);
  assert.strictEqual(b.canRead(pathOf('OTHER', 1), a.readToken), false);
  b.close(a.ticket);
  assert.strictEqual(b.canPublish(pathOf('S', 1), a.ticket), false, 'a released ticket still publishes');
  assert.strictEqual(b.open('S', 1, 'sessB', 'Maria').ok, true, 'the floor was not freed');
});

test('a vanished phone lapses; a renewed talk has NO time limit (Jeff, 2026-10-16)', () => {
  const { b, tick } = mk();
  const a = b.open('S', 1, 'sessA', 'Ryan');
  tick(TICKET_TTL_MS + 1);
  assert.deepStrictEqual(b.sweep(), [{ station: 'S', mic: 1, by: 'Ryan' }]);
  const c = b.open('S', 1, 'sessA', 'Ryan');
  for (let i = 0; i < 300; i++) { tick(2000); assert.strictEqual(b.renew(c.ticket, 'sessA').ok, true); }   // ten minutes
  assert.deepStrictEqual(b.sweep(), []);
  assert.strictEqual(a.ticket === c.ticket, false);
});

test('renewals re-tell the station no more often than RENEW_EVERY_MS; another session cannot renew', () => {
  const { b, tick } = mk();
  const a = b.open('S', 1, 'sessA', 'Ryan');
  tick(2000); assert.strictEqual(b.renew(a.ticket, 'sessA').tellStation, false);
  tick(RENEW_EVERY_MS); assert.strictEqual(b.renew(a.ticket, 'sessA').tellStation, true);
  assert.strictEqual(b.renew(a.ticket, 'sessB').ok, false);
});

test('Stop in Ether (the station reports nobody talking) frees the floor', () => {
  const { b } = mk();
  b.open('S', 1, 'sessA', 'Ryan');
  assert.strictEqual(b.endedByStation('S', 1), true);
  assert.strictEqual(b.state('S')[1], null);
});
