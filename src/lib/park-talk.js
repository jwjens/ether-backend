'use strict';
// src/lib/park-talk.js — Hold to talk: who holds each Park mic, and who may publish/read its voice (2026-10-16,
// docs/park-mic-build-2026-10-16.md in the desktop repo).
//
// Jeff: "logged-in only, one talker per mic, studio lock, follows MUTE where it reaches the park, STOP in Ether, who/when
// shown, limiter, longest talk 20 s".
//
//   · A FLOOR per (station, Park mic): the first logged-in tap gets it; a second one is BUSY ("Ryan is talking") until it
//     ends. It ends when tapped off (stop), when the station ends it (Ether's STOP, the studio lock), or when the page
//     stops renewing (TICKET_TTL_MS — a phone that vanished). NO TIME LIMIT (Jeff, 2026-10-16).
//   · The phone PUBLISHES its mic to the relay with the TICKET (MediaMTX asks /internal/mediamtx/auth); the station
//     READS it with its own READ TOKEN. Both are random, live only while the floor does, and only for that mic's path.
//   · The station is told (park:talk on + a lease) at the start and again while the page renews, no more often than
//     RENEW_EVERY_MS; its own lease and its own longest-talk timer stop it anyway if this server goes quiet.
//
// Memory only: a server restart forgets the floors; the pages' renewals fail and they show HOLD TO TALK again.
// Pure: no DB, no network, no clock of its own. Pinned by park-talk.test.js.
const crypto = require('crypto');

const PARK_MICS = [1, 2];
const TICKET_TTL_MS = 6 * 1000;       // the page renews every 2 s while the button is held
const RENEW_EVERY_MS = 4 * 1000;      // re-tell the station at most this often
const STATION_LEASE_SEC = 8;          // the station stops by itself after this without a renewal

const pathOf = (stationUuid, mic) => `park/${stationUuid}/talk${mic}`;

class TalkBook {
  constructor({ now = () => Date.now(), random = () => crypto.randomBytes(24).toString('hex') } = {}) {
    this.now = now; this.random = random;
    this.floors = new Map();   // `${station}|${mic}` → { station, mic, ticket, readToken, talkId, by, session, since, until, seen, told }
  }
  _k(station, mic) { return `${station}|${mic}`; }
  _live(f) { return !!f && this.now() - f.seen <= TICKET_TTL_MS; }

  /** A tap on. → { ok, ticket, readToken, talkId, tellStation } | { busy, by } */
  open(station, mic, session, by) {
    if (!PARK_MICS.includes(Number(mic))) return { ok: false, error: 'No such Park mic.' };
    const k = this._k(station, mic), f = this.floors.get(k);
    if (f && this._live(f) && f.session !== session) return { ok: false, busy: true, by: f.by };
    const t = this.now();
    const nf = { station, mic: Number(mic), ticket: this.random(), readToken: this.random(), talkId: this.random().slice(0, 16), by,
                 session, since: t, seen: t, told: t };
    this.floors.set(k, nf);
    return { ok: true, ticket: nf.ticket, readToken: nf.readToken, talkId: nf.talkId, tellStation: true, replaced: !!(f && this._live(f)) };
  }
  /** The page is still holding. → { ok, tellStation, station, mic, readToken, talkId, by } | { ok:false } */
  renew(ticket, session) {
    const f = this._byTicket(ticket);
    if (!f || f.session !== session || !this._live(f)) return { ok: false };
    const t = this.now(); f.seen = t;
    const tell = t - f.told >= RENEW_EVERY_MS; if (tell) f.told = t;
    return { ok: true, tellStation: tell, station: f.station, mic: f.mic, readToken: f.readToken, talkId: f.talkId, by: f.by };
  }
  /** Release (or STOP). → { ok, station, mic, by, sec } | { ok:false } */
  close(ticket) {
    const f = this._byTicket(ticket);
    if (!f) return { ok: false };
    this.floors.delete(this._k(f.station, f.mic));
    return { ok: true, station: f.station, mic: f.mic, by: f.by, sec: (this.now() - f.since) / 1000 };
  }
  /** The station says nobody is talking on this mic any more (Stop in Ether, its own limit, the lock): free the floor. */
  endedByStation(station, mic) { const k = this._k(station, mic); const had = this.floors.has(k); this.floors.delete(k); return had; }
  _byTicket(ticket) { if (!ticket) return null; for (const f of this.floors.values()) if (f.ticket === ticket) return f; return null; }

  /** The relay's question for a phone's publish. */
  canPublish(path, token) {
    if (!token) return false;
    for (const f of this.floors.values()) if (pathOf(f.station, f.mic) === path && f.ticket === token && this._live(f)) return true;
    return false;
  }
  /** The relay's question for the station's read. */
  canRead(path, token) {
    if (!token) return false;
    for (const f of this.floors.values()) if (pathOf(f.station, f.mic) === path && f.readToken === token && this._live(f)) return true;
    return false;
  }
  /** Floors that lapsed (the phone stopped renewing): removed; the station is told to stop. [{station, mic}] */
  sweep() {
    const out = [];
    for (const [k, f] of this.floors) if (!this._live(f)) { this.floors.delete(k); out.push({ station: f.station, mic: f.mic, by: f.by }); }
    return out;
  }
  /** Who holds each mic on a station, for the page (by = the staff name; the page shows it to staff only). */
  state(station) {
    const out = {};
    for (const m of PARK_MICS) { const f = this.floors.get(this._k(station, m)); out[m] = f && this._live(f) ? { by: f.by, since: new Date(f.since).toISOString() } : null; }
    return out;
  }
}

module.exports = { TalkBook, pathOf, PARK_MICS, TICKET_TTL_MS, RENEW_EVERY_MS, STATION_LEASE_SEC };
