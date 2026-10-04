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
// "The account" = the signed-in user's license (users.license_key_id) plus any license under the same email; its
// machines are those licenses' active license_activations rows (activation key = licenses.license_key, or "lic-<id>"
// for a license minted without a plaintext key — index.js uses the same fallback).
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

/** The activation keys of the signed-in user's account. */
async function accountActivationKeys(pool, user) {
  const { rows: urows } = await pool.query(`SELECT license_key_id, email FROM users WHERE id = $1`, [user.uid]);
  const u = urows[0] || {};
  const email = String(u.email || user.email || "").toLowerCase();
  const { rows } = await pool.query(
    `SELECT id, license_key FROM licenses WHERE active = true AND (id = $1 OR LOWER(email) = $2)`, [u.license_key_id ?? -1, email]);
  return rows.map(l => l.license_key || `lic-${l.id}`);
}
/** The account's machines (active seats), newest-seen first, one row per machine. */
async function accountMachines(pool, user) {
  const keys = await accountActivationKeys(pool, user);
  if (!keys.length) return [];
  const { rows } = await pool.query(
    `SELECT machine_id, machine_name, os, last_seen FROM license_activations
      WHERE license_key IN (${inList(keys.length)}) AND deauthorized_at IS NULL ORDER BY last_seen DESC`, keys);
  const seen = new Map();
  for (const r of rows) if (!seen.has(r.machine_id)) seen.set(r.machine_id, r);
  return [...seen.values()];
}
async function inAccount(pool, user, machineId) {
  return (await accountMachines(pool, user)).some(m => m.machine_id === machineId);
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
      const ms = await accountMachines(pool, req.user);
      const ids = ms.map(m => m.machine_id);
      const { rows } = ids.length
        ? await pool.query(`SELECT machine_id, machine_name, key_id, fingerprint, updated_at FROM link_keys WHERE machine_id IN (${inList(ids.length)})`, ids)
        : { rows: [] };
      const pub = new Map(rows.map(k => [k.machine_id, k]));
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
      if (!(await inAccount(pool, req.user, b.machineId))) return fail(res, 403, "machine_not_in_account");
      const fp = fingerprint(b.key);
      await pool.query(
        `INSERT INTO link_keys (machine_id, machine_name, key_hex, key_id, fingerprint, published_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (machine_id) DO UPDATE SET machine_name = EXCLUDED.machine_name, key_hex = EXCLUDED.key_hex,
           key_id = EXCLUDED.key_id, fingerprint = EXCLUDED.fingerprint, published_by = EXCLUDED.published_by, updated_at = EXCLUDED.updated_at`,
        [b.machineId, b.machineName, b.key, b.keyId, fp, req.user.uid, now()]);
      res.json({ ok: true, machine_id: b.machineId, key_id: b.keyId, fingerprint: fp });
    } catch (e) { console.error("[link/key put]", e.message); fail(res, 500, "server_error"); }
  });

  // Same account: fetch the key of a machine the receiver picked. Not in the account looks exactly like "no key".
  r.get("/key/:machineId", async (req, res) => {
    const mid = String(req.params.machineId || "");
    try {
      if (!isMachineId(mid) || !(await inAccount(pool, req.user, mid))) return fail(res, 404, "no_published_key");
      const { rows } = await pool.query(`SELECT machine_id, machine_name, key_hex, key_id, fingerprint, updated_at FROM link_keys WHERE machine_id = $1`, [mid]);
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
      if (!(await inAccount(pool, req.user, b.machineId))) return fail(res, 403, "machine_not_in_account");
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
