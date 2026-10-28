'use strict';
// SIGN-IN SESSIONS — Phase 1 of the desktop's docs/account-sign-in-plan-2026-10-26.md, with Jeff's rules (2026-10-28):
//   "A running station stays signed in forever: a short-lived pass (15 minutes, a user setting) renewed silently in the
//    background, with no limit while the computer runs. It ends only on Sign Out, a password change, or the computer
//    being removed from the account, and then within minutes. The offline limit (no check-in for 90 days) is a user
//    setting, with 'never' as a choice."
//
// A session is one signed-in computer. It holds a REFRESH token (opaque, random, only its SHA-256 stored, ROTATED on
// every use) and issues short ACCESS tokens (JWT { uid, email, typ:"user", sid }, the user's access_minutes, 15 by
// default). The refresh token never expires while the computer keeps renewing; it stops working only when the session is
// revoked (Sign Out, password change/reset, the computer removed) or when the computer has not checked in for the user's
// offline_days (90 by default; NULL = never). An access token whose session was revoked is refused within the 30 s cache.
// Presenting a refresh token that was already rotated away is a theft signal: the session is revoked.
// Old access tokens without a sid keep working until their own expiry (no forced sign-out on deploy).
const crypto = require("crypto");
const express = require("express");

const AUTH_SESSIONS_DDL = [
  `CREATE TABLE IF NOT EXISTS auth_sessions (
     id             TEXT PRIMARY KEY,
     user_id        INT  NOT NULL,
     machine_id     TEXT,
     device_name    TEXT,
     method         TEXT NOT NULL DEFAULT 'password',
     refresh_hash   TEXT NOT NULL,
     prev_hash      TEXT,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_used_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     revoked_at     TIMESTAMPTZ,
     revoked_reason TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_sessions_machine ON auth_sessions (machine_id)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS session_access_minutes INT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS session_offline_days INT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS session_offline_never BOOLEAN`,
];

const DEFAULT_ACCESS_MINUTES = 15;
const DEFAULT_OFFLINE_DAYS = 90;
const ACCESS_RANGE = [5, 60];
const OFFLINE_RANGE = [1, 3650];
const CACHE_MS = 30 * 1000;

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const rand = () => crypto.randomBytes(32).toString("base64url");
const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, Math.round(v)));

/** The user's settings: { accessMinutes, offlineDays (null = never) }. */
function settingsOf(u) {
  const am = Number(u && u.session_access_minutes);
  const od = Number(u && u.session_offline_days);
  return {
    accessMinutes: Number.isFinite(am) && am > 0 ? clamp(am, ACCESS_RANGE) : DEFAULT_ACCESS_MINUTES,
    offlineDays: u && u.session_offline_never ? null : (Number.isFinite(od) && od > 0 ? clamp(od, OFFLINE_RANGE) : DEFAULT_OFFLINE_DAYS),
  };
}

function create({ pool, jwt, secret, now = () => Date.now() }) {
  const revokedCache = new Map();   // sid → { revoked, at }

  function signAccess(u, sid) {
    const { accessMinutes } = settingsOf(u);
    // iat from the same clock as everything else here (exp = iat + the user's minutes)
    const iat = Math.floor(now() / 1000);
    return { token: jwt.sign({ uid: u.id, email: u.email, typ: "user", sid, iat }, secret, { expiresIn: `${accessMinutes}m` }), expiresInSec: accessMinutes * 60 };
  }

  /** A new signed-in computer. Returns { access_token, access_expires_in, refresh_token, session_id }. */
  async function start(u, { machineId = null, deviceName = null, method = "password" } = {}) {
    const sid = crypto.randomUUID();
    const secretPart = rand();
    await pool.query(
      `INSERT INTO auth_sessions (id, user_id, machine_id, device_name, method, refresh_hash, created_at, last_used_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [sid, u.id, machineId ? String(machineId).slice(0, 64) : null, deviceName ? String(deviceName).slice(0, 120) : null, method, sha(secretPart), new Date(now())]);
    const a = signAccess(u, sid);
    return { access_token: a.token, access_expires_in: a.expiresInSec, refresh_token: `${sid}.${secretPart}`, session_id: sid };
  }

  async function revokeWhere(where, params, reason) {
    const r = await pool.query(`UPDATE auth_sessions SET revoked_at = $1, revoked_reason = $2 WHERE revoked_at IS NULL AND ${where} RETURNING id`,
      [new Date(now()), reason, ...params]);
    for (const row of r.rows) revokedCache.set(row.id, { revoked: true, at: now() });
    return r.rows.length;
  }
  const revokeSession = (sid, reason) => revokeWhere(`id = $3`, [sid], reason);
  const revokeUser = (userId, reason) => revokeWhere(`user_id = $3`, [userId], reason);
  /** The computer was removed from an account: end its sessions for that account's users. */
  const revokeMachine = (machineId, userIds, reason = "computer_removed") => userIds.length
    ? revokeWhere(`machine_id = $3 AND user_id IN (${userIds.map((_, i) => `$${i + 4}`).join(", ")})`, [machineId, ...userIds], reason)
    : Promise.resolve(0);

  /** Renew: the refresh token → a new access token and a NEW refresh token (the old one stops working). */
  async function refresh(refreshToken) {
    const [sid, secretPart] = String(refreshToken || "").split(".");
    if (!sid || !secretPart) return { error: "invalid_refresh" };
    const s = (await pool.query(`SELECT * FROM auth_sessions WHERE id = $1`, [sid])).rows[0];
    if (!s) return { error: "invalid_refresh" };
    if (s.revoked_at) return { error: "session_ended", reason: s.revoked_reason };
    const h = sha(secretPart);
    if (h !== s.refresh_hash) {
      if (s.prev_hash && h === s.prev_hash) { await revokeSession(sid, "refresh_reused"); return { error: "session_ended", reason: "refresh_reused" }; }
      return { error: "invalid_refresh" };
    }
    const u = (await pool.query(`SELECT * FROM users WHERE id = $1`, [s.user_id])).rows[0];
    if (!u) { await revokeSession(sid, "user_gone"); return { error: "session_ended", reason: "user_gone" }; }
    const { offlineDays } = settingsOf(u);
    if (offlineDays != null && now() - new Date(s.last_used_at).getTime() > offlineDays * 86400000) {
      await revokeSession(sid, "offline_limit");
      return { error: "session_ended", reason: "offline_limit" };
    }
    const next = rand();
    await pool.query(`UPDATE auth_sessions SET prev_hash = refresh_hash, refresh_hash = $1, last_used_at = $2 WHERE id = $3`, [sha(next), new Date(now()), sid]);
    const a = signAccess(u, sid);
    return { access_token: a.token, access_expires_in: a.expiresInSec, refresh_token: `${sid}.${next}`, session_id: sid };
  }

  /** Is this access token's session ended? (cached 30 s; a token without a sid is an old one: never "ended"). */
  async function isRevoked(sid) {
    if (!sid) return false;
    const c = revokedCache.get(sid);
    if (c && (c.revoked || now() - c.at < CACHE_MS)) return c.revoked;
    const row = (await pool.query(`SELECT revoked_at FROM auth_sessions WHERE id = $1`, [sid])).rows[0];
    const revoked = !row || !!row.revoked_at;
    revokedCache.set(sid, { revoked, at: now() });
    return revoked;
  }

  /** Express middleware piece: after the JWT verified, refuse an ended session. */
  async function guard(payload) { return !(await isRevoked(payload && payload.sid)); }

  function router(requireUser, opts = {}) {
    const r = express.Router();
    r.use(express.json());
    if (opts.rateLimit !== false) {
      const rateLimit = require("express-rate-limit");
      r.use("/refresh", rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
    }
    r.post("/refresh", async (req, res) => {
      try {
        const out = await refresh((req.body || {}).refresh_token);
        if (out.error) return res.status(401).json(out);
        res.json(out);
      } catch (e) { console.error("[auth/refresh]", e.message); res.status(500).json({ error: "server_error" }); }
    });
    // UPGRADE: a desktop still holding an old 12 h pass (no session) swaps it, once, for a session while it is valid —
    // so a computer already set up never needs the sign-in screen to start renewing.
    r.post("/upgrade", requireUser, async (req, res) => {
      try {
        if (req.user.sid) return res.status(400).json({ error: "already_a_session" });
        const u = (await pool.query(`SELECT * FROM users WHERE id = $1`, [req.user.uid])).rows[0];
        if (!u) return res.status(401).json({ error: "invalid_token" });
        const b = req.body || {};
        res.json(await start(u, { machineId: b.machine_id || null, deviceName: b.machine_name || null, method: "upgrade" }));
      } catch (e) { console.error("[auth/upgrade]", e.message); res.status(500).json({ error: "server_error" }); }
    });
    // Sign Out (this computer): by its refresh token, so it works even with an expired access token.
    r.post("/logout", async (req, res) => {
      try {
        const [sid, secretPart] = String((req.body || {}).refresh_token || "").split(".");
        const s = sid ? (await pool.query(`SELECT refresh_hash FROM auth_sessions WHERE id = $1`, [sid])).rows[0] : null;
        if (s && secretPart && sha(secretPart) === s.refresh_hash) await revokeSession(sid, "sign_out");
        res.json({ ok: true });
      } catch (e) { console.error("[auth/logout]", e.message); res.status(500).json({ error: "server_error" }); }
    });
    r.post("/logout-all", requireUser, async (req, res) => {
      try { res.json({ ok: true, ended: await revokeUser(req.user.uid, "sign_out_everywhere") }); }
      catch (e) { console.error("[auth/logout-all]", e.message); res.status(500).json({ error: "server_error" }); }
    });
    r.get("/sessions", requireUser, async (req, res) => {
      try {
        const { rows } = await pool.query(
          `SELECT id, machine_id, device_name, method, created_at, last_used_at FROM auth_sessions
            WHERE user_id = $1 AND revoked_at IS NULL ORDER BY last_used_at DESC`, [req.user.uid]);
        res.json({ sessions: rows.map(s => ({ ...s, this_computer: s.id === req.user.sid })) });
      } catch (e) { console.error("[auth/sessions]", e.message); res.status(500).json({ error: "server_error" }); }
    });
    r.delete("/sessions/:id", requireUser, async (req, res) => {
      try {
        const n = await revokeWhere(`id = $3 AND user_id = $4`, [String(req.params.id), req.user.uid], "signed_out_from_another_computer");
        if (!n) return res.status(404).json({ error: "no_such_session" });
        res.json({ ok: true });
      } catch (e) { console.error("[auth/sessions delete]", e.message); res.status(500).json({ error: "server_error" }); }
    });
    // The user's own settings: the pass length (minutes) and the offline limit (days, or never).
    r.get("/settings", requireUser, async (req, res) => {
      const u = (await pool.query(`SELECT * FROM users WHERE id = $1`, [req.user.uid])).rows[0];
      res.json({ ...settingsOf(u), access_range: ACCESS_RANGE, offline_range: OFFLINE_RANGE });
    });
    r.put("/settings", requireUser, async (req, res) => {
      try {
        const b = req.body || {};
        const am = Number(b.access_minutes);
        if (b.access_minutes !== undefined && !(Number.isFinite(am) && am >= ACCESS_RANGE[0] && am <= ACCESS_RANGE[1]))
          return res.status(400).json({ error: "access_minutes_out_of_range", range: ACCESS_RANGE });
        const never = b.offline_days === null || b.offline_days === "never";
        const od = Number(b.offline_days);
        if (b.offline_days !== undefined && !never && !(Number.isFinite(od) && od >= OFFLINE_RANGE[0] && od <= OFFLINE_RANGE[1]))
          return res.status(400).json({ error: "offline_days_out_of_range", range: OFFLINE_RANGE });
        if (b.access_minutes !== undefined) await pool.query(`UPDATE users SET session_access_minutes = $1 WHERE id = $2`, [Math.round(am), req.user.uid]);
        if (b.offline_days !== undefined) await pool.query(`UPDATE users SET session_offline_days = $1, session_offline_never = $2 WHERE id = $3`,
          [never ? null : Math.round(od), never, req.user.uid]);
        const u = (await pool.query(`SELECT * FROM users WHERE id = $1`, [req.user.uid])).rows[0];
        res.json(settingsOf(u));
      } catch (e) { console.error("[auth/settings]", e.message); res.status(500).json({ error: "server_error" }); }
    });
    return r;
  }

  return { start, refresh, isRevoked, guard, revokeSession, revokeUser, revokeMachine, signAccess, router };
}

module.exports = { AUTH_SESSIONS_DDL, DEFAULT_ACCESS_MINUTES, DEFAULT_OFFLINE_DAYS, settingsOf, create };
