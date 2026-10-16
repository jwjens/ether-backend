'use strict';
// node --test src/lib/park-listen.test.js — Park page Listen: tickets, the station's start/stop, the relay's checks.
const test = require('node:test');
const assert = require('node:assert');
const { ListenBook, pathOf, TICKET_TTL_MS, RENEW_EVERY_MS } = require('./park-listen');

const mk = () => { let t = 1_000_000, n = 0; const b = new ListenBook({ now: () => t, random: () => `r${++n}` }); return { b, tick: (ms) => { t += ms; } }; };

test('the first listener tells the station to send; a second does not re-tell it at once', () => {
  const { b } = mk();
  const a = b.open('S', 'sess1');
  assert.strictEqual(a.tellStation, true);
  const c = b.open('S', 'sess2');
  assert.strictEqual(c.tellStation, false);
  assert.strictEqual(a.publishToken, c.publishToken, 'one publish token per station');
});
test('renewal re-tells the station at most every RENEW_EVERY_MS', () => {
  const { b, tick } = mk();
  const { ticket } = b.open('S', 's');
  assert.strictEqual(b.renew(ticket, 's').tellStation, false);
  tick(RENEW_EVERY_MS);
  assert.strictEqual(b.renew(ticket, 's').tellStation, true);
});
test('a ticket cannot be renewed from another session', () => {
  const { b } = mk();
  const { ticket } = b.open('S', 's');
  assert.strictEqual(b.renew(ticket, 'other').ok, false);
});
test('the last listener leaving stops the station; not before', () => {
  const { b } = mk();
  const one = b.open('S', 's1'), two = b.open('S', 's2');
  assert.strictEqual(b.close(one.ticket).stopStation, false);
  assert.strictEqual(b.close(two.ticket).stopStation, true);
  assert.strictEqual(b.canPublish(pathOf('S'), one.publishToken), false, 'the publish token dies with the last listener');
});
test('an unrenewed ticket lapses and its station is stopped; a logged-out session loses its ticket at once', () => {
  const { b, tick } = mk();
  b.open('S', 's');
  tick(TICKET_TTL_MS + 1);
  assert.deepStrictEqual(b.sweep(), ['S']);
  const x = b.open('T', 'gone');
  assert.deepStrictEqual(b.sweep(new Set(['gone'])), ['T']);
  assert.strictEqual(b.canRead(pathOf('T'), x.ticket), false);
});
test('the relay: a reader needs a live ticket for THAT station; a publisher needs that station\'s token', () => {
  const { b } = mk();
  const { ticket, publishToken } = b.open('S', 's');
  assert.strictEqual(b.canRead(pathOf('S'), ticket), true);
  assert.strictEqual(b.canRead(pathOf('OTHER'), ticket), false);
  assert.strictEqual(b.canRead(pathOf('S'), 'nope'), false);
  assert.strictEqual(b.canPublish(pathOf('S'), publishToken), true);
  assert.strictEqual(b.canPublish(pathOf('S'), 'nope'), false);
  assert.strictEqual(b.canPublish(pathOf('OTHER'), publishToken), false);
});

test('the listener buffer: 0 is 0; missing or blank is null, never 0 (2026-10-16)', () => {
  const { bufferMsOf } = require('./park-listen');
  assert.strictEqual(bufferMsOf(0), 0);
  assert.strictEqual(bufferMsOf('0'), 0);
  assert.strictEqual(bufferMsOf(100), 100);
  assert.strictEqual(bufferMsOf(null), null);
  assert.strictEqual(bufferMsOf(undefined), null);
  assert.strictEqual(bufferMsOf(''), null);
  assert.strictEqual(bufferMsOf('x'), null);
});
