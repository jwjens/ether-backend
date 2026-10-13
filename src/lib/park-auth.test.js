'use strict';
// node --test src/lib/park-auth.test.js — Park page staff login rules (2026-10-13).
const test = require('node:test');
const assert = require('node:assert');
const A = require('./park-auth');

const PIN_HASH = 'abc:def';
const S = 'station-hv';
const live = () => ({ ended_at: null, pin_fp: A.pinFingerprint(PIN_HASH), station_uuid: S });

test('a good session stays good', () => {
  assert.deepStrictEqual(A.sessionVerdict(live(), { pin_hash: PIN_HASH, role: 'admin' }, S), { ok: true });
});
test('Log out ends it', () => {
  assert.strictEqual(A.sessionVerdict({ ...live(), ended_at: new Date() }, { pin_hash: PIN_HASH, role: 'admin' }, S).reason, 'logged_out');
});
test('changing the PIN logs every device out', () => {
  assert.strictEqual(A.sessionVerdict(live(), { pin_hash: 'xyz:new', role: 'admin' }, S).reason, 'pin_changed');
});
test('removing the user logs every device out', () => {
  assert.strictEqual(A.sessionVerdict(live(), null, S).reason, 'user_removed');
});
test('admins only: a user who is no longer an admin is logged out', () => {
  assert.strictEqual(A.sessionVerdict(live(), { pin_hash: PIN_HASH, role: 'user' }, S).reason, 'not_admin');
  assert.strictEqual(A.isAdmin({ role: 'Admin' }), true);
  assert.strictEqual(A.isAdmin({ role: 'user' }), false);
  assert.strictEqual(A.isAdmin(null), false);
});
test('a login for one station does not work on another', () => {
  assert.strictEqual(A.sessionVerdict(live(), { pin_hash: PIN_HASH, role: 'admin' }, 'other').reason, 'other_station');
});
test('no session → please log in', () => {
  assert.strictEqual(A.sessionVerdict(null, null, S).reason, 'no_session');
});
test('tokens are random and only their hash is kept', () => {
  const a = A.newSession(), b = A.newSession();
  assert.notStrictEqual(a.token, b.token);
  assert.strictEqual(A.tokenHash(a.token), a.tokenHash);
  assert.ok(!a.tokenHash.includes(a.token));
});
test('lockout: the account settings decide; unset = the values that applied before (5 tries, 15 min)', () => {
  assert.deepStrictEqual(A.lockoutRule(null), { maxFails: 5, lockoutMinutes: 15 });
  assert.deepStrictEqual(A.lockoutRule({ pin_max_fails: 3, pin_lockout_minutes: 30 }), { maxFails: 3, lockoutMinutes: 30 });
});
test('wrong PINs count up, then lock for the set time', () => {
  const rule = { maxFails: 3, lockoutMinutes: 10 }; const now = Date.parse('2026-10-13T10:00:00Z');
  assert.deepStrictEqual(A.afterWrongPin(0, rule, now), { failed_attempts: 1, locked_until: null });
  assert.deepStrictEqual(A.afterWrongPin(1, rule, now), { failed_attempts: 2, locked_until: null });
  const r = A.afterWrongPin(2, rule, now);
  assert.strictEqual(r.failed_attempts, 0);
  assert.strictEqual(r.locked_until.toISOString(), '2026-10-13T10:10:00.000Z');
});
test('settings are checked: whole numbers in range', () => {
  assert.strictEqual(A.validSettings({ pin_max_fails: 0, pin_lockout_minutes: 5 }).ok, false);
  assert.strictEqual(A.validSettings({ pin_max_fails: 5, pin_lockout_minutes: 0 }).ok, false);
  assert.strictEqual(A.validSettings({ pin_max_fails: 2.5, pin_lockout_minutes: 5 }).ok, false);
  assert.deepStrictEqual(A.validSettings({ pin_max_fails: 4, pin_lockout_minutes: 20 }), { ok: true, maxFails: 4, lockoutMinutes: 20 });
});
