'use strict';
// REMOTE LINK RELAY SESSIONS (docs/remote-link-relay-plan-2026-10-28.md, openair; Jeff approved option A, 2026-10-28).
//
// The backend introduces two Ether machines of the SAME account and hands each a signed ticket for the relay
// (relay/ticket.js; the relay checks it with the shared ETHER_RELAY_SECRET). Nobody types an address or a port.
//   POST /api/link/relay/session   the SENDER: "feed station S on machine R". Both machines must hold an active seat in the
//                                  caller's account (the account as fixed by H5/M1: the user's licenses, never an email).
//                                  Returns the relay's host/port, the session tag and the ticket. The same sender,
//                                  receiver and station get the same session back, its ticket renewed (12 h).
//   GET  /api/link/relay/sessions?machine=R   the RECEIVER's poll: live sessions aimed at R, with the sending machine's
//                                  name, so the receiver can ask its operator the first time ("Allow OVEVENTS?") and then
//                                  remember the answer locally. Only for a machine in the caller's account.
// A ticket proves only "the backend introduced these two"; the audio is sealed end to end by the machines' own link key.
const crypto = require("crypto");
const express = require("express");
const { signTicket } = require("../../relay/ticket");
const LP = require("./link-pairing");

const TICKET_MS = 12 * 3600 * 1000;
const LINK_RELAY_DDL = [
  `CREATE TABLE IF NOT EXISTS link_relay_sessions (
     tag            TEXT PRIMARY KEY,
     sender_machine TEXT NOT NULL,
     receiver_machine TEXT NOT NULL,
     station_uuid   TEXT NOT NULL,
     license_id     INT  NOT NULL,
     created_by     INT,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
     expires_at     TIMESTAMPTZ NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_link_relay_receiver ON link_relay_sessions (receiver_machine)`,
];
const isMachineId = (s) => typeof s === "string" && /^[0-9a-z][0-9a-z._-]{0,63}$/i.test(s);
const isUuid = (s) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function router(pool, requireUser, { secret = process.env.ETHER_RELAY_SECRET, host = process.env.ETHER_RELAY_HOST,
                                     port = Number(process.env.ETHER_RELAY_PORT || 9790), now = () => Date.now() } = {}) {
  const r = express.Router();
  r.use(express.json());
  r.use(requireUser);
  const fail = (res, s, error) => res.status(s).json({ error });
  const configured = () => !!(secret && String(secret).length >= 32 && host);

  r.post("/session", async (req, res) => {
    if (!configured()) return fail(res, 503, "relay_not_configured");
    const b = req.body || {};
    if (!isMachineId(b.sender_machine) || !isMachineId(b.receiver_machine)) return fail(res, 400, "machine_ids_required");
    if (!isUuid(b.station_uuid)) return fail(res, 400, "station_uuid_required");
    if (b.sender_machine === b.receiver_machine) return fail(res, 400, "a_machine_cannot_feed_itself");
    try {
      const seats = await LP.accountSeats(pool, req.user);
      const snd = seats.filter(s => s.machine_id === b.sender_machine), rcv = seats.filter(s => s.machine_id === b.receiver_machine);
      // Both machines on one license of the caller's account (never two accounts joined by a shared machine id).
      const lic = snd.map(s => s.license_id).find(l => rcv.some(x => x.license_id === l));
      if (!lic) return fail(res, 403, "machines_not_in_your_account");
      const t = now(), exp = new Date(t + TICKET_MS);
      const existing = (await pool.query(
        `SELECT tag FROM link_relay_sessions WHERE sender_machine = $1 AND receiver_machine = $2 AND station_uuid = $3 AND license_id = $4 AND expires_at > $5`,
        [b.sender_machine, b.receiver_machine, b.station_uuid.toLowerCase(), lic, new Date(t)])).rows[0];
      const tag = existing ? existing.tag : crypto.randomBytes(8).toString("hex");
      if (existing) await pool.query(`UPDATE link_relay_sessions SET expires_at = $1 WHERE tag = $2`, [exp, tag]);
      else await pool.query(
        `INSERT INTO link_relay_sessions (tag, sender_machine, receiver_machine, station_uuid, license_id, created_by, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [tag, b.sender_machine, b.receiver_machine, b.station_uuid.toLowerCase(), lic, req.user.uid, new Date(t), exp]);
      res.json({ relay_host: host, relay_port: port, tag, expires_at: exp.toISOString(),
                 ticket: signTicket(secret, { sessionHex: tag, sender: b.sender_machine, receiver: b.receiver_machine, expiresAt: exp.getTime() }) });
    } catch (e) { console.error("[link/relay/session]", e.message); fail(res, 500, "server_error"); }
  });

  r.get("/sessions", async (req, res) => {
    if (!configured()) return fail(res, 503, "relay_not_configured");
    const m = String(req.query.machine || "");
    if (!isMachineId(m)) return fail(res, 400, "machine_required");
    try {
      const seats = await LP.accountSeats(pool, req.user);
      const lics = [...new Set(seats.filter(s => s.machine_id === m).map(s => s.license_id))];
      if (!lics.length) return res.json({ sessions: [] });   // not your machine: nothing, indistinguishable from none
      const { rows } = await pool.query(
        `SELECT tag, sender_machine, receiver_machine, station_uuid, license_id, expires_at FROM link_relay_sessions
          WHERE receiver_machine = $1 AND expires_at > $2 AND license_id IN (${lics.map((_, i) => `$${i + 3}`).join(", ")})
          ORDER BY created_at`, [m, new Date(now()), ...lics]);
      const names = new Map(seats.map(s => [s.machine_id, s.machine_name]));
      res.json({ relay_host: host, relay_port: port, sessions: rows.map(s => ({
        tag: s.tag, sender_machine: s.sender_machine, sender_name: names.get(s.sender_machine) || null, station_uuid: s.station_uuid,
        expires_at: new Date(s.expires_at).toISOString(),
        ticket: signTicket(secret, { sessionHex: s.tag, sender: s.sender_machine, receiver: s.receiver_machine, expiresAt: new Date(s.expires_at).getTime() }),
      })) });
    } catch (e) { console.error("[link/relay/sessions]", e.message); fail(res, 500, "server_error"); }
  });

  return r;
}

module.exports = { LINK_RELAY_DDL, router, TICKET_MS };
