'use strict';
// src/lib/dashboard-throttle.js — slowing down PIN guessing at the dashboard's team sign-in (Jeff, 2026-11-02, option B).
//
// "Wrong PINs typed with an account email never lock the user; slow down guessing per device and per address instead.
// Make sure no dashboard failure ever locks a PIN at the Ether console or the Park page."
//
//   · The dashboard sign-in NEVER writes account_users.failed_attempts / locked_until — the lockout the Park page uses.
//     (The Ether console's PINs live only on the desktop; nothing from the server reaches them — src/lib/syncUsers.ts is
//     one-way, install → server.)
//   · Instead every failed dashboard sign-in counts against the DEVICE (the dashboard's own random id, sent as device_id)
//     and the ADDRESS (the visitor's IP, req.ip with trust proxy). Too many in the window → that device / address waits.
//   · The numbers are today's lockout numbers (5 wrong tries → 15 minutes; lockoutRuleFor's defaults), applied per
//     device / address instead of per person. They are the current values, shown in the build report.
const DASHBOARD_THROTTLE = { maxFails: 5, minutes: 15 };

/** The throttle keys for a request: its address always, its device when it sent a usable id. */
function throttleKeys(ip, deviceId) {
  const keys = [];
  const a = String(ip || "").trim();
  if (a) keys.push(`ip:${a}`);
  const d = String(deviceId || "").trim();
  if (/^[A-Za-z0-9_-]{8,64}$/.test(d)) keys.push(`dev:${d}`);
  return keys;
}

/** After one more failure on a row ({failures, window_started, blocked_until} or null): the row to store. */
function afterFailure(row, now, rule = DASHBOARD_THROTTLE) {
  const windowMs = rule.minutes * 60 * 1000;
  const fresh = !row || !row.window_started || now - new Date(row.window_started).getTime() >= windowMs;
  const failures = (fresh ? 0 : Number(row.failures) || 0) + 1;
  const window_started = fresh ? new Date(now) : new Date(row.window_started);
  const blocked_until = failures >= rule.maxFails ? new Date(now + windowMs) : (row && row.blocked_until ? new Date(row.blocked_until) : null);
  return { failures: failures >= rule.maxFails ? 0 : failures, window_started: failures >= rule.maxFails ? new Date(now) : window_started, blocked_until };
}

/** The latest time any of these rows is blocked until, or null when none is blocked now. */
function blockedUntil(rows, now) {
  let until = null;
  for (const r of rows) if (r && r.blocked_until && new Date(r.blocked_until).getTime() > now) {
    const t = new Date(r.blocked_until);
    if (!until || t > until) until = t;
  }
  return until;
}

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS dashboard_login_throttle (
    key TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, window_started TIMESTAMPTZ, blocked_until TIMESTAMPTZ)`);
}
async function rowsFor(pool, keys) {
  const out = [];
  for (const k of keys) out.push((await pool.query(`SELECT * FROM dashboard_login_throttle WHERE key = $1`, [k])).rows[0] || null);
  return out;
}
/** Is this request (address / device) waiting? → the time it may try again, or null. */
async function checkThrottle(pool, keys, now = Date.now()) {
  return blockedUntil(await rowsFor(pool, keys), now);
}
/** Count one failed sign-in against each key. */
async function recordFailure(pool, keys, now = Date.now()) {
  const rows = await rowsFor(pool, keys);
  for (let i = 0; i < keys.length; i++) {
    const n = afterFailure(rows[i], now);
    if (rows[i]) await pool.query(`UPDATE dashboard_login_throttle SET failures = $2, window_started = $3, blocked_until = $4 WHERE key = $1`, [keys[i], n.failures, n.window_started, n.blocked_until]);
    else await pool.query(`INSERT INTO dashboard_login_throttle (key, failures, window_started, blocked_until) VALUES ($1, $2, $3, $4)`, [keys[i], n.failures, n.window_started, n.blocked_until]);
  }
}
/** A successful sign-in clears its DEVICE's count (not the address's: one person signing in must not reset what
 *  others sharing that address have tried). */
async function recordSuccess(pool, keys) {
  for (const k of keys) if (k.startsWith("dev:")) await pool.query(`DELETE FROM dashboard_login_throttle WHERE key = $1`, [k]);
}

module.exports = { DASHBOARD_THROTTLE, throttleKeys, afterFailure, blockedUntil, ensureTable, checkThrottle, recordFailure, recordSuccess };
