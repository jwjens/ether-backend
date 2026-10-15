'use strict';

// src/ops-core.js — the pure logic behind Park Ops.
//
// PORTED VERBATIM from the desktop's electron/ops-api.js, which is being retired. These functions
// were the actual product thinking in that file — resolving which closing time applies on a given
// night, and the sanity notes shown beside a row. The transport around them (a station HTTP server
// on the LAN) turned out to be the wrong model: the URL has to be hosted and always reachable,
// whether or not the station is airing. The logic did not change; only where it runs.
//
// Kept pure — no database, no request, no clock of its own — so the smoke test can drive it
// directly, exactly as it did on the desktop side.

// ── the closing-time value ────────────────────────────────────────────────────
// One JSON value per station, holding this shape:
//
//   { "default": "22:00", "byWeekday": { "5": "23:00" }, "byDate": { "2026-10-31": "23:30" } }
//
// Resolution is date -> weekday -> default. The write path only ever sets `default`; the other two
// keys are carried through untouched so the shape does not have to change when scope is ruled on.
//
// Per-weekday CLOSING TIME is not the weekday scope v48 removed. That was per-weekday announcement
// ENTRIES — scheduling complexity deliberately cut. A park closing later on Fridays is a property
// of the park.
function parseClosing(raw) {
  const empty = { default: null, byWeekday: {}, byDate: {} };
  if (!raw) return empty;
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!v || typeof v !== 'object') return empty;
    return {
      default: typeof v.default === 'string' ? v.default : null,
      byWeekday: (v.byWeekday && typeof v.byWeekday === 'object') ? v.byWeekday : {},
      byDate: (v.byDate && typeof v.byDate === 'object') ? v.byDate : {},
    };
  } catch { return empty; }
}

/** date -> weekday -> default. `dateStr` is YYYY-MM-DD; `dow` is 0-6, Sunday first. */
function resolveClosing(cfg, dateStr, dow) {
  return cfg.byDate?.[dateStr] ?? cfg.byWeekday?.[String(dow)] ?? cfg.default ?? null;
}

const hhmmToMin = (s) => {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
};

const secToHms = (n) => {
  const w = ((Math.round(n) % 86400) + 86400) % 86400;
  return `${String(Math.floor(w / 3600)).padStart(2, '0')}:${String(Math.floor((w % 3600) / 60)).padStart(2, '0')}:${String(w % 60).padStart(2, '0')}`;
};

const minToHms = (n) => {
  const w = ((n % 1440) + 1440) % 1440;   // wrap, so "15 minutes after midnight closing" is 00:15
  return `${String(Math.floor(w / 60)).padStart(2, '0')}:${String(w % 60).padStart(2, '0')}:00`;
};

// ── sanity rails — FLAG, never block ──────────────────────────────────────────
// The operator may know something the rule does not: a ride broke down, the fireworks ran late. So a
// rail is a sentence beside the row, not a refusal. What it must catch is the disaster case — a
// closing announcement firing with an hour of park time left.
function railsFor(row, closingMin, allRows) {
  const rails = [];
  const due = hhmmToMin(row.dueTime);
  if (due != null && closingMin != null) {
    let delta = due - closingMin;
    if (delta < -720) delta += 1440;            // across midnight
    if (delta > 720) delta -= 1440;
    if (Math.abs(delta) > 360) {
      rails.push({ level: 'warn', text: `That is ${(Math.abs(delta) / 60).toFixed(1)} hours from closing. Is the closing time right?` });
    }
    if (/clos(ed|ing)/i.test(row.title || '') && delta < -20) {
      rails.push({ level: 'warn', text: 'A closing announcement, but the park is open for a while yet.' });
    }
  }
  for (const other of allRows) {
    if (other === row) continue;
    const o = hhmmToMin(other.dueTime);
    if (due != null && o != null && Math.abs(o - due) * 60 < 60) {
      rails.push({ level: 'warn', text: `Almost the same time as “${other.title}”.` });
      break;
    }
  }
  return rails;
}

// ── did this line play on `dateStr`? ──────────────────────────────────────────
// THE INSTALL SENDS UNIX SECONDS (2026-10-13). Its fire stamps `Math.floor(Date.now() / 1000)` and the mirror sends
// it as a number. This compared the first 10 characters to the date ("1791945000" vs "2026-10-13"), never matched,
// and the page said "not played" for every announcement that had played. A number is read as seconds; a string
// keeps the old date-prefix reading. The server has no station time zone, but each row is ONE date's line
// (scope 'date'), so a play within that date in any zone (UTC-14 to UTC+12 around it) is that date's play.
function playedMs(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;   // seconds, or already milliseconds
  return null;
}
function playedOn(v, dateStr) {
  if (v == null || v === '') return false;
  const ms = playedMs(v);
  if (ms == null) return String(v).slice(0, 10) === dateStr;
  const day = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(day)) return false;
  return ms >= day - 14 * 3600e3 && ms < day + 24 * 3600e3 + 12 * 3600e3;
}
function playedIso(v) {
  const ms = playedMs(v);
  if (ms != null) return new Date(ms).toISOString();
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// ── the queue the page renders ────────────────────────────────────────────────
// `scheduleRows` are the mirrored announcement_schedule rows for ONE date, already joined to their
// announcement title. Pure: the caller supplies the date and the resolved closing time, so this
// never reads a clock and the smoke can pin every branch.
function buildQueue(scheduleRows, closingMin, dateStr) {
  const queue = (scheduleRows || []).map(r => {
    // THE STATION'S OWN FIRE TIME (2026-10-13). The install sends `due_time`: the clock time its announcement
    // scheduler WILL fire this row at (electron/main.js dueTimeFor, resolved against tonight's closing time). That is
    // what the page shows — never a second calculation. The offset arithmetic below is only for an install too old
    // to send it, and it now reads the station's real type name: rows timed from closing are 'close_offset' (this
    // looked for 'before_close', matched nothing, fell back to trigger_time — null on such rows — and the page
    // showed "—"), with v62's seconds taking the minutes' sign.
    const isOffset = (r.trigger_type === 'close_offset' || r.trigger_type === 'before_close');
    const offMin = Number(r.close_offset_min) || 0, offSec = Number(r.close_offset_sec) || 0;
    const offTotalSec = offMin * 60 + (offMin < 0 ? -Math.abs(offSec) : Math.abs(offSec));
    const derived = (isOffset && closingMin != null) ? secToHms(closingMin * 60 + offTotalSec) : null;
    const dueTime = typeof r.due_time === 'string' && r.due_time
      ? String(r.due_time).slice(0, 8)
      : isOffset ? derived : (r.trigger_time ? String(r.trigger_time).slice(0, 8) : null);
    return {
      uuid: r.uuid,
      title: r.title || '(untitled)',
      dueTime,
      offsetMin: isOffset ? offMin : null,
      offsetSec: isOffset ? offTotalSec : null,
      preview: false,
      ducks: r.duck_music == null ? true : !!r.duck_music,
      alreadyPlayed: playedOn(r.last_played_at, dateStr),
      playedAt: playedOn(r.last_played_at, dateStr) ? playedIso(r.last_played_at) : null,
      // SKIPPED and FAILED, each with its time (2026-10-15), so the page shows every line's outcome plainly. Same
      // reading as playedAt: unix seconds from the install, on this line's date. A failure carries the station's reason.
      skippedAt: playedOn(r.skipped_at, dateStr) ? playedIso(r.skipped_at) : null,
      failedAt: playedOn(r.failed_at, dateStr) ? playedIso(r.failed_at) : null,
      failReason: playedOn(r.failed_at, dateStr) && r.fail_reason ? String(r.fail_reason).slice(0, 300) : null,
      rails: [],
    };
  });
  for (const q of queue) q.rails = railsFor(q, closingMin, queue);
  return queue;
}

// ── the announcement on air ───────────────────────────────────────────────────
// What the install pushed as ops_config.announcement_playing, reduced to the fields the page shows. Anything malformed
// is null (not shown), never a guess.
function announcementPlaying(v) {
  if (!v || typeof v !== 'object' || typeof v.title !== 'string' || !v.title) return null;
  if (!Number.isFinite(Date.parse(v.at)) || !Number.isFinite(Date.parse(v.started_at))) return null;
  const dur = Number(v.duration_sec), pos = Number(v.position_sec);
  return {
    title: v.title.slice(0, 200),
    duration_sec: Number.isFinite(dur) && dur > 0 ? dur : 0,
    position_sec: Number.isFinite(pos) && pos > 0 ? pos : 0,
    started_at: new Date(Date.parse(v.started_at)).toISOString(),
    at: new Date(Date.parse(v.at)).toISOString(),
    entry_uuid: typeof v.entry_uuid === 'string' ? v.entry_uuid : null,
  };
}

module.exports = { parseClosing, resolveClosing, hhmmToMin, minToHms, secToHms, railsFor, buildQueue, playedOn, announcementPlaying };
