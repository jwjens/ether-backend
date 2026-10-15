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
// 2026-10-13: the station fires offset rows LIVE (resolved at fire time), so a derived time is no longer a preview.
check('and is the real fire time, not a preview', off.preview, false);
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

// THE INSTALL SENDS UNIX SECONDS (2026-10-13): the 8:29 PM PDT fire on 2026-10-13 is 03:29 UTC the next day.
{
  const row = (lp) => buildQueue([{ uuid: 'n', title: 'T', trigger_time: '20:29:00', trigger_type: 'absolute', date: '2026-10-13', last_played_at: lp }], closingMin, '2026-10-13')[0];
  const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
  check('seconds: 8:29 PM PDT (03:29 UTC next day) reads as played', row(sec('2026-10-14T03:29:00Z')).alreadyPlayed, true);
  check('seconds: playedAt is the fire time',                         row(sec('2026-10-14T03:29:00Z')).playedAt, '2026-10-14T03:29:00.000Z');
  check('seconds as a string reads the same',                         row(String(sec('2026-10-14T03:29:00Z'))).alreadyPlayed, true);
  check('seconds: a play two days earlier does not',                  row(sec('2026-10-11T03:29:00Z')).alreadyPlayed, false);
  check('seconds: a play two days later does not',                    row(sec('2026-10-16T03:29:00Z')).alreadyPlayed, false);
  check('not played -> playedAt null',                                row(null).playedAt, null);
}

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
// 2026-10-13: the station REFUSES to fire an offset row with no closing time (electron/main.js dueTimeFor — a stored
// absolute time on such a row is stale, from before it was converted). The page shows no time, as the station would.
check('and it has no time — the station would not fire it, so the page does not invent one',
  buildQueue(rows, null, dateStr).find(q => q.uuid === 's-off').dueTime, null);

console.log("\n── the station's own fire times (2026-10-13) ──");
// The install sends due_time — the time its scheduler WILL fire the row at. It wins over any arithmetic here.
check("the station's due_time is shown as is",
  buildQueue([{ uuid: 'd', title: 'X', trigger_type: 'close_offset', close_offset_min: -15, due_time: '20:44:30', date: dateStr }], closingMin, dateStr)[0].dueTime, '20:44:30');
// The station's type name is 'close_offset' (this looked for 'before_close' only and showed "—").
const co = buildQueue([{ uuid: 'c', title: 'X', trigger_type: 'close_offset', close_offset_min: -15, close_offset_sec: 30, date: dateStr }], closingMin, dateStr)[0];
check("'close_offset' rows are timed from closing (−15 min 30 s before)", co.dueTime, minToHms(closingMin - 16).slice(0, 6) + '30');
check("and carry their offset", co.offsetMin, -15);
check('a row with no title still renders', buildQueue([{ uuid: 'n', trigger_time: '20:00:00', trigger_type: 'absolute', date: dateStr }], closingMin, dateStr)[0].title, '(untitled)');

console.log('\n── station scoping: the SHAPE the route relies on ──');
// Scoping itself is enforced by the route (slug -> station_uuid -> station_cc_data). What is pure,
// and asserted here, is that shaping one station's rows never reaches for another's.
const forest = buildQueue([{ uuid: 'f-1', title: 'FOREST ONLY', trigger_time: '20:00:00', trigger_type: 'absolute', date: dateStr }], hhmmToMin('21:00'), dateStr);
check('a second station shapes only the rows it was given', forest.map(q => q.uuid), ['f-1']);
check('and against its OWN closing time', resolveClosing(parseClosing(JSON.stringify({ default: '21:00' })), dateStr, 6), '21:00');

console.log('\n── skipped / failed / the announcement on air (2026-10-15) ──');
{
  const { announcementPlaying } = require('../src/ops-core');
  const d = '2026-10-13';
  const at829 = Date.parse('2026-10-14T03:29:00Z') / 1000;   // 8:29 PM PDT on the 13th
  const q = buildQueue([
    { uuid: 'sk', title: 'S', trigger_time: '20:29:00', trigger_type: 'absolute', date: d, skipped_at: at829 },
    { uuid: 'fa', title: 'F', trigger_time: '20:29:00', trigger_type: 'absolute', date: d, failed_at: at829, fail_reason: 'No source channel is patched to Announcement' },
    { uuid: 'ok', title: 'O', trigger_time: '20:29:00', trigger_type: 'absolute', date: d },
  ], hhmmToMin('21:00'), d);
  const by = id => q.find(x => x.uuid === id);
  check('a skipped line carries skippedAt', by('sk').skippedAt, '2026-10-14T03:29:00.000Z');
  check('a failed line carries failedAt', by('fa').failedAt, '2026-10-14T03:29:00.000Z');
  check("and the station's reason", by('fa').failReason, 'No source channel is patched to Announcement');
  check('a line with neither has nulls', [by('ok').skippedAt, by('ok').failedAt, by('ok').failReason], [null, null, null]);
  check("a failure on another date is not this line's", buildQueue([{ uuid: 'x', trigger_time: '20:00:00', trigger_type: 'absolute', date: d, failed_at: at829 + 3 * 86400, fail_reason: 'r' }], hhmmToMin('21:00'), d)[0].failedAt, null);
  const ap = announcementPlaying({ title: 'HALLOVEEN 30 MIN', duration_sec: 38.2, started_at: '2026-10-14T03:29:00.000Z', position_sec: 4.5, at: '2026-10-14T03:29:04.500Z', entry_uuid: 'e1' });
  check('the airing announcement passes through', [ap.title, ap.duration_sec, ap.position_sec, ap.entry_uuid], ['HALLOVEEN 30 MIN', 38.2, 4.5, 'e1']);
  check('nothing airing is null', announcementPlaying(null), null);
  check('no title is null, not a blank card', announcementPlaying({ duration_sec: 3, started_at: '2026-10-14T03:29:00Z', at: '2026-10-14T03:29:00Z' }), null);
  check('a bad time is null', announcementPlaying({ title: 'X', started_at: 'nope', at: 'nope' }), null);
  check('an unknown length is 0 (no countdown), never negative', announcementPlaying({ title: 'X', duration_sec: -1, started_at: '2026-10-14T03:29:00Z', at: '2026-10-14T03:29:00Z' }).duration_sec, 0);
}


console.log('\n──────────────────────────────');
console.log(`  Passed: ${pass}  Failed: ${fail}`);
console.log(`  VERDICT: ${fail === 0 ? 'PASS' : 'FAIL'}`);
console.log('──────────────────────────────');

process.exit(fail === 0 ? 0 : 1);
