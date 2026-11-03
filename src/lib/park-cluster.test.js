'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('./park-cluster');
const A = require('./park-auth');

test('park.ether-cast.com/<name>: the cluster, a renamed cluster, an old station link, a station of an account with no cluster name', () => {
  assert.deepStrictEqual(C.resolveParkName('ov', { slug: 'ov' }, null, null), { kind: 'cluster', cluster: 'ov' });
  assert.deepStrictEqual(C.resolveParkName('oldov', null, { slug: 'ov' }, null), { kind: 'redirect', cluster: 'ov', station: null });
  assert.deepStrictEqual(C.resolveParkName('halloveen', null, null, { slug: 'halloveen', clusterSlug: 'ov' }), { kind: 'redirect', cluster: 'ov', station: 'halloveen' });
  assert.deepStrictEqual(C.resolveParkName('solo', null, null, { slug: 'solo', clusterSlug: null }), { kind: 'station', station: 'solo' });
  assert.deepStrictEqual(C.resolveParkName('nothing', null, null, null), { kind: 'not_found' });
  assert.deepStrictEqual(C.resolveParkName('', { slug: 'x' }, null, null), { kind: 'not_found' });
  // the cluster name wins over a station of the SAME name (it is that account's own station: the page selects it there)
  assert.deepStrictEqual(C.resolveParkName('ov', { slug: 'ov' }, null, { slug: 'ov', clusterSlug: 'ov' }), { kind: 'cluster', cluster: 'ov' });
});

test('the station the page opens on: asked (old link) > remembered for this login > first — never one outside the cluster', () => {
  const st = [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }];
  assert.strictEqual(C.pickStation(st, { asked: 'c', remembered: 'b' }), 'c');
  assert.strictEqual(C.pickStation(st, { asked: null, remembered: 'b' }), 'b');
  assert.strictEqual(C.pickStation(st, {}), 'a');
  assert.strictEqual(C.pickStation(st, { asked: 'elsewhere', remembered: 'nowhere' }), 'a');
  assert.strictEqual(C.pickStation([], { asked: 'a' }), null);
});

test("a cluster name another account's station already uses is refused; this account's own station is fine", () => {
  assert.strictEqual(C.clusterNameClash([{ license_key_id: 7 }], 7), false);
  assert.strictEqual(C.clusterNameClash([{ license_key_id: 8 }], 7), true);
  assert.strictEqual(C.clusterNameClash([], 7), false);
});

test('a cluster login (station_uuid NULL) is good for every station of its account, and only those; still logged out by PIN change / removal / log out', () => {
  const PIN = 'salt:abc';
  const sess = { ended_at: null, pin_fp: A.pinFingerprint(PIN), station_uuid: null, license_key_id: 7 };
  assert.deepStrictEqual(A.sessionVerdict(sess, { pin_hash: PIN }, 'station-1', 7), { ok: true });
  assert.deepStrictEqual(A.sessionVerdict(sess, { pin_hash: PIN }, 'station-2', '7'), { ok: true });
  assert.strictEqual(A.sessionVerdict(sess, { pin_hash: PIN }, 'other-account-station', 8).reason, 'other_account');
  assert.strictEqual(A.sessionVerdict(sess, { pin_hash: PIN }, 'unknown-station', null).reason, 'other_account');
  assert.strictEqual(A.sessionVerdict(sess, { pin_hash: 'salt:new' }, 'station-1', 7).reason, 'pin_changed');
  assert.strictEqual(A.sessionVerdict(sess, null, 'station-1', 7).reason, 'user_removed');
  assert.strictEqual(A.sessionVerdict({ ...sess, ended_at: new Date() }, { pin_hash: PIN }, 'station-1', 7).reason, 'logged_out');
  // an old per-station login: its own station only, as before
  const old = { ...sess, station_uuid: 'station-1' };
  assert.deepStrictEqual(A.sessionVerdict(old, { pin_hash: PIN }, 'station-1', 7), { ok: true });
  assert.strictEqual(A.sessionVerdict(old, { pin_hash: PIN }, 'station-2', 7).reason, 'other_station');
});
