'use strict';
// src/lib/broadcast-owner.js — ONE broadcast owner per station (Jeff, 2026-10-13).
//
// THE BUG: every machine that has a station loaded and believes its stream is live posts now-playing for it, and
// the upsert took whichever arrived last. HalloVeen, live from OVEVENTS, flipped every few seconds with a report from
// ovowforestmusic (engine off, decks empty, its stream status stuck on "live"): the Remote page and the Park page
// alternated between "LIVE · sourced from OVEVENTS" and "STOPPED · sourced from ovowforestmusic".
//
// THE RULE: a station has ONE current owner — the machine holding the broadcast. Only the owner's reports update the
// station's live status, decks and now playing. Any other machine's report is recorded as STANDBY and never
// overwrites the owner's. The owner changes only when the broadcast really moves:
//   1. there is no owner yet;
//   2. the owner has gone silent (no report for HEARTBEAT_STALE_MS — it stopped streaming, quit, or lost the net);
//   3. a machine GOES LIVE: it had been silent (its last report is older than the window) and now claims the
//      stream — the "go live" / Move broadcast moment as the server sees it;
//   4. the claimant is actually on air (engine live) and the owner is not (stopped / off / stalled) — a machine
//      playing the station outranks one that holds the claim with nothing playing.
// A machine that has been claiming all along (no gap) never takes the broadcast from a fresh owner that is on air —
// that is exactly the stuck second install, and it now shows as "standby".
//
// A report with no machine id (an install too old to send source_machine_id) can't be an owner; it is applied only
// when there is no fresh owner (the old behaviour, kept for single-machine stations on old builds).
//
// Pure: no DB, no clock of its own (now is passed in), so every branch is pinned by broadcast-owner.test.js.

const OWNER_STALE_MS = 90 * 1000;   // same window as station-state.js HEARTBEAT_STALE_MS (~4 missed 20 s keepalives)

const ms = (t) => (t == null ? 0 : (t instanceof Date ? t.getTime() : new Date(t).getTime()) || 0);

/**
 * @param {object} p
 * @param {{machine_id:string, seen_at:any, engine_state:string|null}|null} p.owner   the current owner, or null
 * @param {{machine_id:string|null, engine_state:string|null}} p.claimant             this report
 * @param {{last_report_at:any}|null} p.prior                                        this machine's previous report
 * @param {number} p.now
 * @returns {{apply:boolean, take:boolean, reason:string}}
 */
function decideReport({ owner, claimant, prior, now }) {
  const id = claimant && claimant.machine_id ? String(claimant.machine_id) : null;
  const ownerFresh = !!(owner && owner.machine_id && (now - ms(owner.seen_at)) < OWNER_STALE_MS);

  if (!id) return ownerFresh ? { apply: false, take: false, reason: "no-id-owner-fresh" } : { apply: true, take: false, reason: "no-id-no-owner" };
  if (owner && owner.machine_id === id) return { apply: true, take: false, reason: "owner" };
  if (!owner || !owner.machine_id) return { apply: true, take: true, reason: "no-owner" };
  if (!ownerFresh) return { apply: true, take: true, reason: "owner-silent" };
  const wentLive = !!(prior && prior.last_report_at && (now - ms(prior.last_report_at)) >= OWNER_STALE_MS);
  // Going live with nothing playing never takes the broadcast from an owner that IS on air: a stuck install that
  // restarts (a gap, then the same stale claim) must not grab it for a tick.
  if (wentLive && (claimant.engine_state === "live" || owner.engine_state !== "live")) return { apply: true, take: true, reason: "went-live" };
  if (claimant.engine_state === "live" && owner.engine_state !== "live") return { apply: true, take: true, reason: "on-air-beats-stopped" };
  return { apply: false, take: false, reason: "standby" };
}

/**
 * The stream error to SHOW for a station, or null. An error belongs to the broadcast it happened in: one from before
 * the current owner took the broadcast is history, and once the station is live and healthy again an error older
 * than RECOVERED_MS is history too. (The 2026-07-24 "Forbidden (403)" sat on HalloVeen's Remote card for 80 days
 * because the column was COALESCE'd forever and shown as-is.)
 */
const RECOVERED_MS = 10 * 60 * 1000;
function currentError({ last_error, last_error_at, owner_since, state }, now) {
  if (!last_error) return null;
  const at = ms(last_error_at);
  if (!at) return null;
  if (owner_since && at < ms(owner_since) - 60 * 1000) return null;   // before this broadcast (60 s for clock skew)
  if (state === "live" && (now - at) >= RECOVERED_MS) return null;     // recovered
  return { last_error, last_error_at };
}

module.exports = { decideReport, currentError, OWNER_STALE_MS, RECOVERED_MS };
