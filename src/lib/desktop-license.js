'use strict';
const { licenseExpired } = require("./entitlement");
// WHICH LICENSE A SIGNED-IN USER'S DESKTOP ACTIVATES ON (POST /api/user/desktop-activate).
//
// Jeff, 2026-10-28: "never hand a license to someone by email match. A license is claimed only with its key or by a
// verified, invited member." (docs/link-access-audit-and-email-2026-10-28.md §2 row 1.)
//
// It used to hand a user with no license of their own the newest active trial license whose EMAIL matched theirs — and
// signup never verifies an email, so a stranger who signed up with a trial customer's email got that customer's license
// key and a seat on it. Now, in order:
//   1. the user's own license (users.license_key_id — set when they claimed it with its key, or when it was issued to
//      them here);
//   2. the account they were INVITED to (an active membership), only if their email is verified;
//   3. otherwise a BRAND-NEW trial license of their own. Never an existing license found by email.

/**
 * Resolve (and if needed create) the license for user `u`. `generateLicenseKey(plan)` makes a new plaintext key.
 * `entitled` = the user's OWN entitlement allows activating (their license or their trial is current) — the gate the
 * route always had. An invited member is gated on the ACCOUNT's license instead (not expired), since a member may have
 * no trial of their own. Returns { license, via: "own" | "member" | "new" }, or null when nothing may be activated.
 */
async function resolveDesktopLicense(pool, u, { generateLicenseKey, entitled = true, now = Date.now() }) {
  if (u.license_key_id && entitled) {
    const own = (await pool.query(`SELECT * FROM licenses WHERE id = $1 AND active = true`, [u.license_key_id])).rows[0];
    if (own) return { license: own, via: "own" };
  }
  if (u.email_verified) {
    const rows = (await pool.query(
      `SELECT l.* FROM memberships m JOIN licenses l ON l.id = m.account_id
        WHERE m.user_id = $1 AND m.status = 'active' AND m.deleted_at IS NULL AND l.active = true
        ORDER BY m.id ASC`, [u.id])).rows;
    // a member uses the account's license; they are not made its owner (license_key_id unchanged)
    const m = rows.find(l => !licenseExpired(l, now));
    if (m) return { license: m, via: "member" };
  }
  if (!entitled) return null;
  const email = String(u.email || "").trim().toLowerCase();
  const rawKey = generateLicenseKey("station");
  const license = (await pool.query(
    `INSERT INTO licenses (email, plan, license_key, key_prefix, expires_at, active)
     VALUES ($1, 'station', $2, $3, $4, true) RETURNING *`,
    [email, rawKey, rawKey.slice(0, 12), u.trial_ends_at]
  )).rows[0];
  await pool.query(`UPDATE users SET license_key_id = $1 WHERE id = $2`, [license.id, u.id]);
  return { license, via: "new" };
}

module.exports = { resolveDesktopLicense };
