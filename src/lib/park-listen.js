'use strict';
// src/lib/park-listen.js — who is listening on a station's Park page, and who may publish/read its feed
// (2026-10-13, docs/park-listen-plan-2026-10-13.md in the desktop repo).
//
// Jeff: "Logged-in users only. One plain button: 'Listen' … It never starts by itself … It must not add load or risk
// to the air chain."
//
//   · A LISTENER is a logged-in Park session that pressed Listen. It gets a TICKET (random, kept here only as a hash
//     key) that the relay (MediaMTX) checks before it serves the feed, and that the page renews while it plays. An
//     unrenewed ticket lapses after TICKET_TTL_MS.
//   · The STATION is told to send (park:listen on:true + a lease) while it has at least one listener, renewed no more
//     often than RENEW_EVERY_MS; when the last listener goes, it is told to stop. The station's own lease
//     (STATION_LEASE_SEC) stops it anyway if this server goes quiet — nothing is left running on the air machine.
//   · The station PUBLISHES with a per-station token minted when the first listener arrives; the relay checks it.
//
// Memory only: a server restart forgets listeners, the pages' renewals fail, and they show Listen off again.
// Pure: no DB, no network, no clock of its own. Pinned by park-listen.test.js.
const crypto = require('crypto');

const TICKET_TTL_MS = 45 * 1000;      // the page renews every 15 s
const RENEW_EVERY_MS = 15 * 1000;     // re-tell the station at most this often
const STATION_LEASE_SEC = 60;         // the station stops by itself after this without a renewal

const pathOf = (stationUuid) => `park/${stationUuid}`;

class ListenBook {
  constructor({ now = () => Date.now(), random = () => crypto.randomBytes(24).toString('hex') } = {}) {
    this.now = now; this.random = random;
    this.tickets = new Map();     // ticket → { station, session, at }
    this.publish = new Map();     // station → publish token
    this.told = new Map();        // station → last time the station was told on:true
  }
  listeners(station) { let n = 0; for (const t of this.tickets.values()) if (t.station === station) n++; return n; }

  /** A logged-in session pressed Listen. Returns the ticket, the station's publish token, and whether to tell it. */
  open(station, session) {
    const ticket = this.random();
    this.tickets.set(ticket, { station, session, at: this.now() });
    if (!this.publish.has(station)) this.publish.set(station, this.random());
    return { ticket, publishToken: this.publish.get(station), tellStation: this._due(station) };
  }
  /** The page is still listening. False = the ticket is unknown or belongs to another session (it must re-open). */
  renew(ticket, session) {
    const t = this.tickets.get(ticket);
    if (!t || t.session !== session) return { ok: false };
    t.at = this.now();
    return { ok: true, station: t.station, publishToken: this.publish.get(t.station), tellStation: this._due(t.station) };
  }
  /** Listen pressed off (or the page closed). */
  close(ticket) {
    const t = this.tickets.get(ticket);
    if (!t) return { ok: false };
    this.tickets.delete(ticket);
    return { ok: true, station: t.station, stopStation: this._endIfEmpty(t.station) };
  }
  /** Lapse unrenewed tickets (and every ticket of an ended session). Returns the stations that now have nobody. */
  sweep(endedSessions = new Set()) {
    const cutoff = this.now() - TICKET_TTL_MS, touched = new Set();
    for (const [k, t] of this.tickets) if (t.at < cutoff || endedSessions.has(t.session)) { this.tickets.delete(k); touched.add(t.station); }
    return [...touched].filter(s => this._endIfEmpty(s));
  }
  /** The relay's question: may this reader have this path? */
  canRead(path, token) {
    const t = this.tickets.get(String(token || ''));
    return !!t && pathOf(t.station) === path && t.at >= this.now() - TICKET_TTL_MS;
  }
  /** The relay's question: may this publisher send this path? */
  canPublish(path, token) {
    for (const [station, tok] of this.publish) if (pathOf(station) === path) return !!token && tok === String(token);
    return false;
  }
  _due(station) {
    const last = this.told.get(station) || 0;
    if (this.now() - last < RENEW_EVERY_MS) return false;
    this.told.set(station, this.now());
    return true;
  }
  _endIfEmpty(station) {
    if (this.listeners(station) > 0) return false;
    this.publish.delete(station); this.told.delete(station);
    return true;
  }
}

module.exports = { ListenBook, pathOf, TICKET_TTL_MS, RENEW_EVERY_MS, STATION_LEASE_SEC };
