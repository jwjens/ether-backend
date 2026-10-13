'use strict';
// node --test src/lib/broadcast-owner.test.js — ONE owner per station; the 2026-10-13 HalloVeen flip pinned.
const test = require('node:test');
const assert = require('node:assert');
const { decideReport, currentError, OWNER_STALE_MS } = require('./broadcast-owner');

const NOW = Date.parse('2026-10-13T09:00:00Z');
const ago = (s) => new Date(NOW - s * 1000);
const OVE = { machine_id: 'ovevents', seen_at: ago(5), engine_state: 'live' };

test('THE HALLOVEEN FLIP: a machine claiming all along, engine off, never displaces the on-air owner', () => {
  const r = decideReport({ owner: OVE, claimant: { machine_id: 'ovowforest', engine_state: 'off' }, prior: { last_report_at: ago(20) }, now: NOW });
  assert.deepStrictEqual(r, { apply: false, take: false, reason: 'standby' });
});
test('…and on the first report after the deploy (no prior record) it is still standby', () => {
  const r = decideReport({ owner: OVE, claimant: { machine_id: 'ovowforest', engine_state: 'off' }, prior: null, now: NOW });
  assert.strictEqual(r.apply, false);
});
test('the owner\'s own reports always apply, whatever they say (a stopped owner reads stopped)', () => {
  assert.deepStrictEqual(decideReport({ owner: OVE, claimant: { machine_id: 'ovevents', engine_state: 'off' }, prior: { last_report_at: ago(20) }, now: NOW }),
    { apply: true, take: false, reason: 'owner' });
});
test('no owner yet → the first claimant takes it', () => {
  assert.strictEqual(decideReport({ owner: null, claimant: { machine_id: 'a', engine_state: 'off' }, prior: null, now: NOW }).take, true);
});
test('owner silent past the window → the broadcast moves', () => {
  const owner = { ...OVE, seen_at: ago(OWNER_STALE_MS / 1000 + 1) };
  assert.deepStrictEqual(decideReport({ owner, claimant: { machine_id: 'b', engine_state: 'live' }, prior: { last_report_at: ago(30) }, now: NOW }),
    { apply: true, take: true, reason: 'owner-silent' });
});
test('GO LIVE: a machine that had been silent and now claims the stream takes the broadcast from a fresh owner', () => {
  assert.deepStrictEqual(decideReport({ owner: OVE, claimant: { machine_id: 'b', engine_state: 'live' }, prior: { last_report_at: ago(3600) }, now: NOW }),
    { apply: true, take: true, reason: 'went-live' });
});
test('a stuck install that restarts (gap, same claim, nothing playing) does NOT take it from the on-air owner', () => {
  assert.strictEqual(decideReport({ owner: OVE, claimant: { machine_id: 'ovowforest', engine_state: 'off' }, prior: { last_report_at: ago(3600) }, now: NOW }).apply, false);
});
test('on air beats stopped: a playing claimant takes over from an owner that is not live', () => {
  const owner = { ...OVE, engine_state: 'off' };
  assert.strictEqual(decideReport({ owner, claimant: { machine_id: 'b', engine_state: 'live' }, prior: { last_report_at: ago(20) }, now: NOW }).reason, 'on-air-beats-stopped');
  // …but a stopped claimant never takes it from a stopped owner (no flip-flop between two idle machines)
  assert.strictEqual(decideReport({ owner, claimant: { machine_id: 'b', engine_state: 'off' }, prior: { last_report_at: ago(20) }, now: NOW }).apply, false);
});
test('a report with no machine id (old install) applies only when there is no fresh owner', () => {
  assert.strictEqual(decideReport({ owner: OVE, claimant: { machine_id: null, engine_state: 'off' }, prior: null, now: NOW }).apply, false);
  assert.strictEqual(decideReport({ owner: null, claimant: { machine_id: null, engine_state: 'live' }, prior: null, now: NOW }).apply, true);
});
test('two machines claiming on alternate ticks: once one owns it, the other stays standby every tick (no flip)', () => {
  let owner = null; const seen = {};
  const tick = (id, eng, t) => {
    const r = decideReport({ owner, claimant: { machine_id: id, engine_state: eng }, prior: seen[id] ? { last_report_at: seen[id] } : null, now: t });
    seen[id] = new Date(t);
    if (r.apply) owner = { machine_id: id, seen_at: new Date(t), engine_state: eng };
    return r.apply;
  };
  const shown = [];
  for (let i = 0; i < 20; i++) {
    const t = NOW + i * 10_000;
    if (tick('ovowforest', 'off', t)) shown.push('ovowforest');
    if (tick('ovevents', 'live', t + 3000)) shown.push('ovevents');
  }
  // ovowforest may hold it for the very first tick (nobody else had reported); from then on only OVEVENTS shows.
  assert.ok(shown.slice(1).every(x => x === 'ovevents'), shown.join(','));
});

test('the 80-day-old 403: an error from before the current owner took the broadcast is not shown', () => {
  assert.strictEqual(currentError({ last_error: 'Forbidden (403)', last_error_at: '2026-07-24T18:42:48Z', owner_since: ago(600), state: 'live' }, NOW), null);
});
test('a live, healthy station hides an error older than 10 minutes; a fresh one shows', () => {
  assert.strictEqual(currentError({ last_error: 'x', last_error_at: ago(11 * 60), owner_since: ago(3600), state: 'live' }, NOW), null);
  assert.ok(currentError({ last_error: 'x', last_error_at: ago(60), owner_since: ago(3600), state: 'live' }, NOW));
});
test('a station that is NOT live keeps showing its error from this broadcast (it is why it is down)', () => {
  assert.ok(currentError({ last_error: 'Forbidden (403)', last_error_at: ago(3 * 3600), owner_since: ago(4 * 3600), state: 'off' }, NOW));
});
