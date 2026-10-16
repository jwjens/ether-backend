'use strict';
// src/lib/park-talk.js — Park mic: each phone's warm line, and who holds each Park mic (2026-10-16,
// docs/park-mic-build-2026-10-16.md in the desktop repo).
//
// THE STANDING RULE (Jeff, 2026-10-16): "the user is in charge of on and off. The system never assumes, never listens for
// talking, never ends a talk because of silence, and never auto-stops. Once green, it stays open until the user taps off,
// or a person presses STOP / the studio lock in Ether."
//
//   · A WARM LINE per phone whose microphone is on: the phone PUBLISHES to its own relay path with its ticket; the
//     station READS it with its read token (MediaMTX asks /internal/mediamtx/auth for both). The phone renews it; one it
//     stops renewing (the page closed) lapses — but a line that is in a talk never lapses here (the rule).
//   · A FLOOR per (station, Park mic): a tap takes it; another phone is BUSY ("Ryan is talking"). It ends ONLY when the
//     talker taps off, or the station ends it (Ether's STOP, the studio lock). No timer, no lease, no silence rule.
//
// Memory only: a server restart forgets lines and floors; the phones reconnect their lines on their own.
// Pure: no DB, no network, no clock of its own. Pinned by park-talk.test.js.
const crypto = require('crypto');

const PARK_MICS = [1, 2];
const WARM_TTL_MS = 20 * 1000;        // a phone renews its line every 5 s; a line not renewed for this long lapses …
const RENEW_EVERY_MS = 10 * 1000;     // … and the station is re-told about it at most this often
const STATION_LEASE_SEC = 30;         // the station's cleanup lease for a line nobody talks on

const warmPathOf = (stationUuid, warmId) => `park/${stationUuid}/w/${warmId}`;

class TalkBook {
  constructor({ now = () => Date.now(), random = () => crypto.randomBytes(24).toString('hex') } = {}) {
    this.now = now; this.random = random;
    this.lines = new Map();    // warmId → { station, warmId, ticket, readToken, session, seen, told }
    this.floors = new Map();   // `${station}|${mic}` → { station, mic, warmId, talkId, by, session, since }
  }
  _k(station, mic) { return `${station}|${mic}`; }
  _inTalk(warmId) { for (const f of this.floors.values()) if (f.warmId === warmId) return true; return false; }
  _lineLive(l) { return !!l && (this.now() - l.seen <= WARM_TTL_MS || this._inTalk(l.warmId)); }

  // ── warm lines ──
  /** A phone's microphone turned on: its line. → { ok, warmId, ticket, readToken } */
  warm(station, session) {
    const t = this.now();
    const l = { station, warmId: this.random().slice(0, 16), ticket: this.random(), readToken: this.random(), session, seen: t, told: t };
    this.lines.set(l.warmId, l);
    return { ok: true, warmId: l.warmId, ticket: l.ticket, readToken: l.readToken };
  }
  /** The phone is still there. → { ok, tellStation, station, warmId, readToken } | { ok:false } */
  warmRenew(ticket, session) {
    const l = this._lineByTicket(ticket);
    if (!l || l.session !== session || !this._lineLive(l)) return { ok: false };
    const t = this.now(); l.seen = t;
    const tell = t - l.told >= RENEW_EVERY_MS; if (tell) l.told = t;
    return { ok: true, tellStation: tell, station: l.station, warmId: l.warmId, readToken: l.readToken };
  }
  /** The phone turned its microphone off. Never ends a talk on that line (a person ends a talk). */
  warmClose(ticket) {
    const l = this._lineByTicket(ticket);
    if (!l) return { ok: false };
    if (this._inTalk(l.warmId)) return { ok: true, kept: 'in a talk', station: l.station, warmId: l.warmId };
    this.lines.delete(l.warmId);
    return { ok: true, station: l.station, warmId: l.warmId };
  }
  line(warmId) { return this.lines.get(warmId) || null; }
  _lineByTicket(ticket) { if (!ticket) return null; for (const l of this.lines.values()) if (l.ticket === ticket) return l; return null; }

  // ── the floor ──
  /** A tap ON. → { ok, talkId, tellStation } | { busy, by } | { ok:false, error } */
  open(station, mic, session, by, warmId) {
    if (!PARK_MICS.includes(Number(mic))) return { ok: false, error: 'No such Park mic.' };
    const l = this.lines.get(warmId);
    if (!l || l.station !== station || l.session !== session) return { ok: false, error: "This phone's line isn't connected. Tap to reconnect." };
    const k = this._k(station, mic), f = this.floors.get(k);
    if (f && f.session !== session) return { ok: false, busy: true, by: f.by };
    if (f && f.warmId === warmId) return { ok: true, talkId: f.talkId, tellStation: true, already: true };
    const nf = { station, mic: Number(mic), warmId, talkId: this.random().slice(0, 16), by, session, since: this.now() };
    this.floors.set(k, nf);
    return { ok: true, talkId: nf.talkId, tellStation: true };
  }
  /** Tap OFF (or the station ended it). → { ok, station, mic, by, sec } | { ok:false } */
  close(station, mic, session) {
    const k = this._k(station, mic), f = this.floors.get(k);
    if (!f || (session != null && f.session !== session)) return { ok: false };
    this.floors.delete(k);
    return { ok: true, station: f.station, mic: f.mic, by: f.by, sec: (this.now() - f.since) / 1000 };
  }
  /** The station says nobody is talking on this mic any more (Ether's STOP, the studio lock): free the floor. */
  endedByStation(station, mic) { const k = this._k(station, mic); const had = this.floors.has(k); this.floors.delete(k); return had; }
  floor(station, mic) { return this.floors.get(this._k(station, mic)) || null; }

  /** The relay's question for a phone's publish (its own line, with its ticket). */
  canPublish(path, token) {
    if (!token) return false;
    for (const l of this.lines.values()) if (warmPathOf(l.station, l.warmId) === path && l.ticket === token && this._lineLive(l)) return true;
    return false;
  }
  /** The relay's question for the station's read (the line's read token). */
  canRead(path, token) {
    if (!token) return false;
    for (const l of this.lines.values()) if (warmPathOf(l.station, l.warmId) === path && l.readToken === token && this._lineLive(l)) return true;
    return false;
  }
  /** Lines whose phone stopped renewing and that no talk uses: removed; the station is told. [{station, warmId}].
   *  Floors are NEVER swept (the standing rule). */
  sweep() {
    const out = [];
    for (const [id, l] of this.lines) if (!this._lineLive(l)) { this.lines.delete(id); out.push({ station: l.station, warmId: id }); }
    return out;
  }
  /** Who holds each mic on a station, for the page (by = the staff name; the page shows it to staff only). */
  state(station) {
    const out = {};
    for (const m of PARK_MICS) { const f = this.floors.get(this._k(station, m)); out[m] = f ? { by: f.by, since: new Date(f.since).toISOString(), warmId: f.warmId } : null; }
    return out;
  }
}

module.exports = { TalkBook, warmPathOf, PARK_MICS, WARM_TTL_MS, RENEW_EVERY_MS, STATION_LEASE_SEC };
