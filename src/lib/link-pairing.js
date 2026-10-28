'use strict';
// Remote Link pairing — Jeff's ruling, 2026-10-04: the link key is never copied or typed by hand.
//
//   SAME ACCOUNT (the default path): each Ether machine PUBLISHES its link key here under its machine id. A machine on
//   the same account lists the account's machines (license_activations, active seats only) and FETCHES the key of the
//   one it picks. "Replace key" on the sender re-publishes; receivers re-fetch.
//
//   GUEST (a machine on a different account): the sender asks for an 8-character code, shown XXXX-XXXX, valid 10
//   minutes, ONE use. The receiver types it; this hands the key over once and deletes the code. Only a SHA-256 of the
//   code is stored, never the code.
//
// "The account" = the licenses the signed-in USER belongs to: users.license_key_id, plus the accounts of the user's
// active memberships. NEVER a license that merely shares the user's email (docs/multitenancy-audit.md H5, closed
// 2026-10-28: signup never verifies an email, so a stranger who signed up with a customer's purchase email used to
// get that customer's machines and link keys). Its machines are those licenses' active license_activations rows
// (activation key = licenses.license_key, or "lic-<id>" for a license minted without a plaintext key).
//
// A KEY BELONGS TO (license, machine), never to a machine id alone (audit M1, closed 2026-10-28): machine ids are chosen
// by the client and survive a move between accounts, so link_account_keys is keyed by both. A key published under one
// account is invisible to every other account, whatever machine id it names. The old link_keys table (machine id only)
// is no longer read or written; each Ether machine re-publishes its key at start and hourly, into the new table.
//
// Mounted at /api/link behind requireUser (typ:"user" JWT — the desktop's account_jwt). Shared DDL so the pg-mem
// test runs the exact statements index.js applies. Additive / idempotent.
const crypto = require("crypto");
const express = require("express");

/** No 0/O, 1/I/L: a code read off one screen and typed into another. 31 symbols ^ 8 ≈ 2^39.6. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LEN = 8;
const CODE_TTL_MS = 10 * 60 * 1000;

const LINK_PAIRING_DDL = [
  `CREATE TABLE IF NOT EXISTS link_keys (
     machine_id     TEXT PRIMARY KEY,
     machine_name   TEXT,
     key_hex        TEXT NOT NULL,
     key_id         INT  NOT NULL,
     fingerprint    TEXT NOT NULL,
     published_by   INT,
     updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS link_pair_codes (
     code_hash      TEXT PRIMARY KEY,
     machine_id     TEXT NOT NULL,
     machine_name   TEXT,
     key_hex        TEXT NOT NULL,
     key_id         INT  NOT NULL,
     created_by     INT,
     expires_at     TIMESTAMPTZ NOT NULL,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_link_pair_codes_machine ON link_pair_codes (machine_id)`,
  // M1: one key per (license, machine). Replaces link_keys, which is left in place and no longer used.
  `CREATE TABLE IF NOT EXISTS link_account_keys (
     license_id     INT  NOT NULL,
     machine_id     TEXT NOT NULL,
     machine_name   TEXT,
     key_hex        TEXT NOT NULL,
     key_id         INT  NOT NULL,
     fingerprint    TEXT NOT NULL,
     published_by   INT,
     updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (license_id, machine_id)
   )`,
];

function makeCode(randomInt = crypto.randomInt) {
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}
const formatCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
/** What the receiver typed → the 8 symbols, or null. Case, spaces and the dash are forgiven; look-alikes are not guessed. */
function normalizeCode(input) {
  const s = String(input || "").toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== CODE_LEN) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}
const hashCode = (c) => crypto.createHash("sha256").update(`ether-link-pair:${c}`).digest("hex");
/** The same fingerprint the desktop shows (audiod/link.js keyFingerprint), so the two screens can be compared. */
const fingerprint = (keyHex) =>
  crypto.createHash("sha256").update(String(keyHex)).digest("hex").slice(0, 8).toUpperCase().replace(/(.{4})/, "$1-");
const isKeyHex = (s) => typeof s === "string" && /^[0-9a-f]{64}$/i.test(s);
const isMachineId = (s) => typeof s === "string" && /^[0-9a-z][0-9a-z._-]{0,63}$/i.test(s);
/** "$1, $2, …" for an IN list. Used instead of = ANY($1): pg-mem (the test database) misses rows with ANY on an
 *  indexed TEXT key, and the test must run the same SQL production runs. */
const inList = (n, from = 1) => Array.from({ length: n }, (_, i) => `$${i + from}`).join(", ");
const keyIdOf = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 0x7fffffff ? n : null; };

/** The signed-in user's licenses: users.license_key_id and the accounts of their active memberships. Never by email. */
async function accountLicenses(pool, user) {
  const ids = new Set();
  const { rows: urows } = await pool.query(`SELECT license_key_id FROM users WHERE id = $1`, [user.uid]);
  if (urows[0] && urows[0].license_key_id != null) ids.add(Number(urows[0].license_key_id));
  try {
    const { rows } = await pool.query(
      `SELECT account_id FROM memberships WHERE user_id = $1 AND status = 'active' AND deleted_at IS NULL`, [user.uid]);
    for (const r of rows) ids.add(Number(r.account_id));
  } catch (e) { if (!/memberships/.test(String(e && e.message))) throw e; }   // no memberships table: the user's license only
  const list = [...ids].filter(Number.isFinite);
  if (!list.length) return [];
  const { rows } = await pool.query(`SELECT id, license_key FROM licenses WHERE active = true AND id IN (${inList(list.length)})`, list);
  return rows.map(l => ({ id: Number(l.id), activationKey: l.license_key || `lic-${l.id}` }));
}
/** The account's machines (active seats), newest-seen first, one row per (license, machine). */
async function accountSeats(pool, user) {
  const lics = await accountLicenses(pool, user);
  if (!lics.length) return [];
  const byKey = new Map(lics.map(l => [l.activationKey, l.id]));
  const keys = [...byKey.keys()];
  const { rows } = await pool.query(
    `SELECT license_key, machine_id, machine_name, os, last_seen FROM license_activations
      WHERE license_key IN (${inList(keys.length)}) AND deauthorized_at IS NULL ORDER BY last_seen DESC`, keys);
  const seen = new Set(), out = [];
  for (const r of rows) {
    const licenseId = byKey.get(r.license_key);
    const k = `${licenseId}|${r.machine_id}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push({ ...r, license_id: licenseId });
  }
  return out;
}
/** One row per machine for the list (a machine seated under two of the user's licenses is listed once). */
async function accountMachines(pool, user) {
  const seen = new Map();
  for (const r of await accountSeats(pool, user)) if (!seen.has(r.machine_id)) seen.set(r.machine_id, r);
  return [...seen.values()];
}
/** The user's licenses this machine holds an active seat on (usually one). Empty = not in the account. */
async function seatLicenses(pool, user, machineId) {
  return [...new Set((await accountSeats(pool, user)).filter(s => s.machine_id === machineId).map(s => s.license_id))];
}

function router(pool, requireUser, opts = {}) {
  const now = opts.now || (() => new Date());
  const r = express.Router();
  r.use(express.json());
  r.use(requireUser);
  if (opts.rateLimit !== false) {
    const rateLimit = require("express-rate-limit");
    // A code is ~2^39.6 guesses; this keeps a guesser to a few hundred an hour per caller.
    r.use("/pair-redeem", rateLimit({ windowMs: 60 * 1000, limit: 6, standardHeaders: true, legacyHeaders: false,
                                       keyGenerator: (req) => `u${req.user && req.user.uid}` }));
    r.use("/pair-code", rateLimit({ windowMs: 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false,
                                     keyGenerator: (req) => `u${req.user && req.user.uid}` }));
  }
  const fail = (res, status, error) => res.status(status).json({ error });
  const keyBody = (b) => {
    if (!isMachineId(b.machine_id)) return { err: "machine_id_required" };
    if (!isKeyHex(b.key)) return { err: "key_must_be_64_hex" };
    const keyId = keyIdOf(b.key_id);
    if (!keyId) return { err: "key_id_required" };
    return { machineId: b.machine_id, machineName: String(b.machine_name || "").slice(0, 120), key: b.key.toLowerCase(), keyId };
  };

  // The account's machines, with whether each has published a key. Never carries a key.
  r.get("/machines", async (req, res) => {
    try {
      const seats = await accountSeats(pool, req.user);
      const ms = await accountMachines(pool, req.user);
      const lics = [...new Set(seats.map(s => s.license_id))];
      const { rows } = lics.length
        ? await pool.query(`SELECT license_id, machine_id, machine_name, key_id, fingerprint, updated_at FROM link_account_keys WHERE license_id IN (${inList(lics.length)}) ORDER BY updated_at DESC`, lics)
        : { rows: [] };
      // Only a key published under the license the machine is seated on in THIS account.
      const seated = new Set(seats.map(s => `${s.license_id}|${s.machine_id}`));
      const pub = new Map();
      for (const k of rows) if (seated.has(`${k.license_id}|${k.machine_id}`) && !pub.has(k.machine_id)) pub.set(k.machine_id, k);
      res.json({ machines: ms.map(m => {
        const k = pub.get(m.machine_id);
        return { machine_id: m.machine_id, machine_name: (k && k.machine_name) || m.machine_name || null, os: m.os || null,
                 last_seen: m.last_seen, published: !!k, key_id: k ? k.key_id : null, fingerprint: k ? k.fingerprint : null,
                 key_updated_at: k ? k.updated_at : null };
      }) });
    } catch (e) { console.error("[link/machines]", e.message); fail(res, 500, "server_error"); }
  });

  // A machine publishes (or re-publishes, after Replace key) its own key. Only for a machine in the caller's account.
  r.put("/key", async (req, res) => {
    const b = keyBody(req.body || {});
    if (b.err) return fail(res, 400, b.err);
    try {
      const lics = await seatLicenses(pool, req.user, b.machineId);
      if (!lics.length) return fail(res, 403, "machine_not_in_account");
      const fp = fingerprint(b.key);
      // Under each of the caller's licenses this machine is seated on — and nowhere else.
      for (const lic of lics) {
        await pool.query(
          `INSERT INTO link_account_keys (license_id, machine_id, machine_name, key_hex, key_id, fingerprint, published_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (license_id, machine_id) DO UPDATE SET machine_name = EXCLUDED.machine_name, key_hex = EXCLUDED.key_hex,
             key_id = EXCLUDED.key_id, fingerprint = EXCLUDED.fingerprint, published_by = EXCLUDED.published_by, updated_at = EXCLUDED.updated_at`,
          [lic, b.machineId, b.machineName, b.key, b.keyId, fp, req.user.uid, now()]);
      }
      res.json({ ok: true, machine_id: b.machineId, key_id: b.keyId, fingerprint: fp });
    } catch (e) { console.error("[link/key put]", e.message); fail(res, 500, "server_error"); }
  });

  // Same account: fetch the key of a machine the receiver picked. Not in the account looks exactly like "no key".
  r.get("/key/:machineId", async (req, res) => {
    const mid = String(req.params.machineId || "");
    try {
      const lics = isMachineId(mid) ? await seatLicenses(pool, req.user, mid) : [];
      if (!lics.length) return fail(res, 404, "no_published_key");
      // Only a key published under a license this machine is seated on in the caller's account.
      const { rows } = await pool.query(
        `SELECT machine_id, machine_name, key_hex, key_id, fingerprint, updated_at FROM link_account_keys
          WHERE machine_id = $1 AND license_id IN (${inList(lics.length, 2)}) ORDER BY updated_at DESC`, [mid, ...lics]);
      if (!rows.length) return fail(res, 404, "no_published_key");
      const k = rows[0];
      res.json({ machine_id: k.machine_id, machine_name: k.machine_name, key: k.key_hex, key_id: k.key_id, fingerprint: k.fingerprint, updated_at: k.updated_at });
    } catch (e) { console.error("[link/key get]", e.message); fail(res, 500, "server_error"); }
  });

  // Guest pairing, sender side: a fresh code for this machine's current key. An earlier unredeemed code for the same
  // machine is replaced — one live code per machine.
  r.post("/pair-code", async (req, res) => {
    const b = keyBody(req.body || {});
    if (b.err) return fail(res, 400, b.err);
    try {
      if (!(await seatLicenses(pool, req.user, b.machineId)).length) return fail(res, 403, "machine_not_in_account");
      const t = now();
      await pool.query(`DELETE FROM link_pair_codes WHERE machine_id = $1 OR expires_at <= $2`, [b.machineId, t]);
      const code = makeCode();
      const expires = new Date(t.getTime() + CODE_TTL_MS);
      await pool.query(
        `INSERT INTO link_pair_codes (code_hash, machine_id, machine_name, key_hex, key_id, created_by, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [hashCode(code), b.machineId, b.machineName, b.key, b.keyId, req.user.uid, expires, t]);
      res.json({ code: formatCode(code), expires_at: expires.toISOString() });
    } catch (e) { console.error("[link/pair-code]", e.message); fail(res, 500, "server_error"); }
  });

  // Guest pairing, receiver side: one use. The row is deleted as it is read, so a second redeem finds nothing.
  r.post("/pair-redeem", async (req, res) => {
    const code = normalizeCode((req.body || {}).code);
    if (!code) return fail(res, 400, "code_must_be_8_characters");
    try {
      const t = now();
      const { rows } = await pool.query(
        `DELETE FROM link_pair_codes WHERE code_hash = $1 RETURNING machine_id, machine_name, key_hex, key_id, expires_at`, [hashCode(code)]);
      const k = rows[0];
      if (!k || new Date(k.expires_at).getTime() <= t.getTime()) return fail(res, 404, "code_invalid_or_expired");
      res.json({ machine_id: k.machine_id, machine_name: k.machine_name, key: k.key_hex, key_id: k.key_id, fingerprint: fingerprint(k.key_hex) });
    } catch (e) { console.error("[link/pair-redeem]", e.message); fail(res, 500, "server_error"); }
  });

  return r;
}

module.exports = { LINK_PAIRING_DDL, CODE_ALPHABET, CODE_TTL_MS, makeCode, formatCode, normalizeCode, fingerprint, router };
