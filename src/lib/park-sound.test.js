'use strict';
// node --test src/lib/park-sound.test.js — the Park page's sound fader stays steady (2026-10-13).
const test = require('node:test');
const assert = require('node:assert');
const { opsConfigWrite, ownerOnline, CURRENT_FRESH_MS } = require('./park-sound');

const NOW = Date.parse('2026-10-13T11:06:20Z');
const current = { uuid: 'ops', closing: '{}', closing_today: '21:00', local_date: '2026-10-13', park: { level: 0.49, top_db: 0, muted: false }, pushed_at: '2026-10-13T11:06:00Z' };
const older = { uuid: 'ops', closing: '{}', local_date: '2026-10-13' };   // what the older build sends

test('a current-build push always applies', () => {
  assert.deepStrictEqual(opsConfigWrite(current, { ...current, pushed_at: '2026-10-13T11:06:19Z' }, NOW).reason, 'current_build');
});
test('the older build cannot wipe the level while the current build is reporting (the vanishing fader)', () => {
  const r = opsConfigWrite(current, older, NOW);
  assert.strictEqual(r.write, null);
  assert.strictEqual(r.reason, 'older_build_ignored');
});
test('when the current build has stopped reporting, the older row applies but the last known level is kept', () => {
  const r = opsConfigWrite(current, older, Date.parse(current.pushed_at) + CURRENT_FRESH_MS + 1);
  assert.strictEqual(r.reason, 'older_build_applied');
  assert.deepStrictEqual(r.write.park, current.park);
  assert.strictEqual(r.write.closing_today, undefined);
});
test('no stored row: the older row applies as sent', () => {
  assert.deepStrictEqual(opsConfigWrite(null, older, NOW).write, older);
});
test('online = the owning machine has its command connection open', () => {
  const clients = [{ machineId: 'ovevents' }, { machineId: 'forest', writableEnded: true }];
  assert.strictEqual(ownerOnline(clients, 'ovevents'), true);
  assert.strictEqual(ownerOnline(clients, 'forest'), false);
  assert.strictEqual(ownerOnline(clients, null), false);
  assert.strictEqual(ownerOnline(undefined, 'ovevents'), false);
});
