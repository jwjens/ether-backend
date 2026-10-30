'use strict';
const crypto = require("crypto");
// EMAIL VERIFICATION AT SIGN-UP (Jeff, 2026-10-29): "the confirmation link lasts 24 hours; an unverified person may start
// a trial on a brand-new license of their own, but can't claim or join anything that already exists until verified."
// Plan: docs/link-access-audit-and-email-2026-10-28.md §3 (desktop repo).
//
//   · The link carries a random token; only its SHA-256 is stored (users.verify_token), with users.verify_expires
//     24 hours out. A link works once.
//   · Unverified: sign-in works and a brand-new trial license of their own works (desktop-activate's "new" path).
//   · Unverified: a MEMBERSHIP in an account that is not their own license does not count — no member sign-in to it,
//     no switching into it, no listing it, no Link machines of it, no desktop activation on it. The membership row is
//     kept; it counts the moment the email is confirmed.
//   · A password reset proves the inbox, so it confirms the email too.

const VERIFY_HOURS = 24;
const VERIFY_DDL = [`ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_expires TIMESTAMPTZ`];

const hashToken = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");

/** A membership `m` (memberships row) of user `u` (users row) counts only when the email is verified, or the account is
 *  the user's own license. SQL form, for a query that joins memberships m and users u. */
const MEMBERSHIP_COUNTS_SQL = `(u.email_verified = true OR u.license_key_id = m.account_id)`;

/** New confirmation link for user `userId`: returns the raw token (for the email); stores its hash, 24 h. */
async function issue(pool, userId, { now = Date.now() } = {}) {
  const raw = crypto.randomBytes(24).toString("base64url");
  await pool.query(`UPDATE users SET verify_token = $1, verify_expires = $2 WHERE id = $3`,
    [hashToken(raw), new Date(now + VERIFY_HOURS * 3600 * 1000), userId]);
  return raw;
}

/** Confirm with the raw token from the link. Returns { ok:true, userId } or { ok:false, error:"invalid_token"|"expired" }. */
async function confirm(pool, raw, { now = Date.now() } = {}) {
  if (!raw) return { ok: false, error: "missing_token" };
  const h = hashToken(raw);
  const r = await pool.query(
    `UPDATE users SET email_verified = true, verify_token = NULL, verify_expires = NULL
      WHERE verify_token = $1 AND verify_expires > $2 RETURNING id`, [h, new Date(now)]);
  if (r.rowCount) return { ok: true, userId: r.rows[0].id };
  const stale = (await pool.query(`SELECT 1 FROM users WHERE verify_token = $1`, [h])).rows[0];
  return { ok: false, error: stale ? "expired" : "invalid_token" };
}

/** The not-yet-verified user an (expired) link was sent to, or null. Lets "send a new link" work from the link itself
 *  without signing in: the new link goes only to that user's own stored address, never to one the request names. */
async function userForLink(pool, raw) {
  if (!raw) return null;
  return (await pool.query(
    `SELECT id, email, unsubscribe_token FROM users WHERE verify_token = $1 AND email_verified IS NOT TRUE`, [hashToken(raw)])).rows[0] || null;
}

/** The inbox was proven another way (a password reset link): the email is confirmed; any open link is spent. */
async function markVerified(pool, userId) {
  await pool.query(`UPDATE users SET email_verified = true, verify_token = NULL, verify_expires = NULL WHERE id = $1`, [userId]);
}

module.exports = { VERIFY_HOURS, VERIFY_DDL, MEMBERSHIP_COUNTS_SQL, hashToken, issue, confirm, markVerified, userForLink };
