'use strict';
// scripts/smoke-ops-core.js — Park Ops, the pure logic.
//
// PORTED from the desktop's scripts/smoke-ops-api.js when Park Ops moved from a station-served LAN
// page to a hosted page at park.ether-cast.com/<station-slug>. Every assertion about the LOGIC came
// with it unchanged, because the logic did not change — only where it runs.
//
// WHAT MOVED AND WHAT DID NOT, stated plainly so nobody reads this as full coverage:
//   • closing-time resolution, offset arithmetic, sanity rails, queue shaping — ALL still pure, all
//     still pinned here, driven by fixtures instead of a SQLite database.
//   • station scoping and the write token are no longer pure. They are enforced by the route against
//     Postgres (station_metadata.slug -> station_uuid, and station_ops_token). Their fixtures below
//     pin the SHAPE the route depends on; the enforcement itself is a route test, not this file.
//   • now-playing no longer comes from a local audio engine. It is read from station_now_playing,
//     so "the engine will not answer" is now "the station is not pushing", asserted as a null.
//
//   node scripts/smoke-ops-core.js

const { parseClosing, resolveClosing, hhmmToMin, minToHms, railsFor, buildQueue } = require('../src/ops-core');

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

console.log('=== smoke-ops-core ===');

console.log('\n── closing-time resolution: date → weekday → default ──');
const cfg = parseClosing(JSON.stringify({ default: '22:00', byWeekday: { '5': '23:00' }, byDate: { '2026-10-31': '23:30' } }));
check('a specific date wins',            resolveClosing(cfg, '2026-10-31', 6), '23:30');
check('otherwise the weekday wins',      resolveClosing(cfg, '2026-11-06', 5), '23:00');
check('otherwise the default',           resolveClosing(cfg, '2026-11-04', 3), '22:00');
check('nothing configured → null, not a guess', resolveClosing(parseClosing(null), '2026-11-04', 3), null);
check('garbage in the stored value degrades to empty, never throws', parseClosing('{not json').default, null);
check('an already-parsed object is accepted too (JSONB arrives parsed)',
  parseClosing({ default: '21:00', byWeekday: {}, byDate: {} }).default, '21:00');

console.log('\n── offset arithmetic ──');
check('15 minutes before a 22:00 close', minToHms(hhmmToMin('22:00') - 15), '21:45:00');
check('15 minutes after',                minToHms(hhmmToMin('22:00') + 15), '22:15:00');
check('after a 23:50 close wraps past midnight', minToHms(hhmmToMin('23:50') + 25), '00:15:00');
check('a bad time is null, not NaN',     hhmmToMin('99:99'), null);

console.log('\n── THE ENGINE IS UNTOUCHED — offsets are display-only ──');
// An absolute row and an offset row on the same date. The offset row must come back with a DERIVED
// time and preview:true; the absolute row must come back with exactly what the engine will fire.
const dateStr = '2026-10-31';
const rows = [
  { uuid: 's-abs', title: 'PARK IS CLOSED',      trigger_time: '22:00:00', trigger_type: 'absolute',     close_offset_min: 0,   duck_music: 1, sort_order: 0, date: dateStr },
  { uuid: 's-off', title: '15 MINUTES TO CLOSE', trigger_time: '09:00:00', trigger_type: 'before_close', close_offset_min: -15, duck_music: 1, sort_order: 1, date: dateStr },
  { uuid: 's-nod', title: 'NO DUCK ONE',         trigger_time: '22:05:00', trigger_type: 'absolute',     close_offset_min: 0,   duck_music: 0, sort_order: 2, date: dateStr },
];
const closingMin = hhmmToMin('22:00');
const queue = buildQueue(rows, closingMin, dateStr);

const abs = queue.find(q => q.uuid === 's-abs');
const off = queue.find(q => q.uuid === 's-off');
check('the absolute row keeps the time the engine will fire', abs.dueTime, '22:00:00');
check('the absolute row is not a preview', abs.preview, false);
check('the offset row is DERIVED from closing time', off.dueTime, '21:45:00');
check('and is flagged as a preview', off.preview, true);
check('the offset is reported so the page can say it in words', off.offsetMin, -15);
check('the source row is NOT mutated — nothing rewrote the stored time',
  rows.find(r => r.uuid === 's-off').trigger_time, '09:00:00');
check('every row survives the shaping', queue.length, 3);

console.log('\n── plain language comes from the row, never assumed ──');
check('a ducking row says so',      queue.find(q => q.uuid === 's-abs').ducks, true);
check('a non-ducking row does not', queue.find(q => q.uuid === 's-nod').ducks, false);
check('a row with no duck field defaults to ducking',
  buildQueue([{ uuid: 'x', title: 'T', trigger_time: '20:00:00', trigger_type: 'absolute', date: dateStr }], closingMin, dateStr)[0].ducks, true);

console.log('\n── already-played is per DATE, not a boolean anyone can smear ──');
check('played today reads as played',
  buildQueue([{ uuid: 'p', title: 'T', trigger_time: '20:00:00', trigger_type: 'absolute', date: dateStr, last_played_at: dateStr + ' 20:00:01' }], closingMin, dateStr)[0].alreadyPlayed, true);
check('played on another date does not',
  buildQueue([{ uuid: 'p', title: 'T', trigger_time: '20:00:00', trigger_type: 'absolute', date: dateStr, last_played_at: '2026-10-30 20:00:01' }], closingMin, dateStr)[0].alreadyPlayed, false);

console.log('\n── sanity rails FLAG, and never remove a row ──');
const early = buildQueue([{ uuid: 's-early', title: 'PARK IS CLOSED', trigger_time: '09:00:00', trigger_type: 'absolute', date: dateStr }], closingMin, dateStr);
check('the row is still listed', early.length, 1);
check('and it is flagged',       early[0].rails.length > 0, true);
console.log(`         rail: "${early[0].rails[0]?.text}"`);
check('a sane row is not flagged',
  buildQueue([{ uuid: 'ok', title: 'PARADE IN TEN', trigger_time: '21:30:00', trigger_type: 'absolute', date: dateStr }], closingMin, dateStr)[0].rails.length, 0);
check('a closing announcement while the park is open is called out',
  railsFor({ title: 'PARK IS CLOSING', dueTime: '19:00:00' }, closingMin, []).some(r => /open for a while/.test(r.text)), true);
check('two rows a minute apart are called out',
  railsFor({ title: 'A', dueTime: '21:00:00' }, closingMin, [{ title: 'A', dueTime: '21:00:00' }, { title: 'B', dueTime: '21:00:30' }]).some(r => /Almost the same time/.test(r.text)), true);
check('with no closing time set, rails do not invent one',
  railsFor({ title: 'PARK IS CLOSED', dueTime: '09:00:00' }, null, []).length, 0);

console.log('\n── the empty / dark park ──');
// The hosted page is ALWAYS reachable. A station that has never pushed, or has nothing on today,
// is a normal state and must shape into an empty queue rather than an error.
check('no rows at all → an empty queue, not a throw', buildQueue([], closingMin, dateStr).length, 0);
check('null rows → an empty queue',                   buildQueue(null, closingMin, dateStr).length, 0);
check('no closing time → rows still shape, absolute times intact',
  buildQueue(rows, null, dateStr).find(q => q.uuid === 's-abs').dueTime, '22:00:00');
check('no closing time → an offset row cannot be derived, so it is not a preview',
  buildQueue(rows, null, dateStr).find(q => q.uuid === 's-off').preview, false);
check('and it falls back to the stored absolute time rather than inventing one',
  buildQueue(rows, null, dateStr).find(q => q.uuid === 's-off').dueTime, '09:00:00');
check('a row with no title still renders', buildQueue([{ uuid: 'n', trigger_time: '20:00:00', trigger_type: 'absolute', date: dateStr }], closingMin, dateStr)[0].title, '(untitled)');

console.log('\n── station scoping: the SHAPE the route relies on ──');
// Scoping itself is enforced by the route (slug -> station_uuid -> station_cc_data). What is pure,
// and asserted here, is that shaping one station's rows never reaches for another's.
const forest = buildQueue([{ uuid: 'f-1', title: 'FOREST ONLY', trigger_time: '20:00:00', trigger_type: 'absolute', date: dateStr }], hhmmToMin('21:00'), dateStr);
check('a second station shapes only the rows it was given', forest.map(q => q.uuid), ['f-1']);
check('and against its OWN closing time', resolveClosing(parseClosing(JSON.stringify({ default: '21:00' })), dateStr, 6), '21:00');

console.log('\n──────────────────────────────');
console.log(`  Passed: ${pass}  Failed: ${fail}`);
console.log(`  VERDICT: ${fail === 0 ? 'PASS' : 'FAIL'}`);
console.log('──────────────────────────────');

process.exit(fail === 0 ? 0 : 1);
