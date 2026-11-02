'use strict';
// A LICENSE ISSUED IN THE PLATFORM GOES TO AN EMAIL — the email is the license (Jeff, 2026-11-01). Customers never see or
// use a key; keys are internal and may be rotated behind the scenes.
//
// ISSUING (planIssue = the preview Jeff sees before he clicks Issue; issueLicense = the same decision, carried out):
//   · no account with that email            → a new license; it links when they create the account and confirm the email
//   · account, email confirmed, no license  → a new license, linked now
//   · account, email NOT confirmed, no lic. → a new license; it links when they confirm
//   · account whose license is lifetime / Enterprise → REFUSED (lifetime licenses are never modified — Rulings 2026-10-05)
//   · account with a paid Stripe subscription → REFUSED: "This account has a paid subscription; change it in Stripe first."
//   · any other account license (a trial, a Local or platform-made license) → THAT license takes the issued plan with no end
//     date — no second license; its stations, backups and data stay exactly where they are
//
// LINKING (linkIssuedLicense, run when the email is confirmed, at desktop sign-in and when the account page loads).
// Jeff's 10/28 rule holds where it matters: NEVER on an unconfirmed email. With a confirmed email, the newest license
// issued to it that is active, not a trial, not expired and not held by any other account:
//   · the account has no license → linked
//   · the account's license is a trial (they signed in to Ether before confirming) → that trial takes the issued plan with no
//     end date (stations stay), and the issued license — now an unused duplicate — is switched off (Jeff's decision 5)
//   · anything else (a paid or lifetime license of its own) → nothing changes
const { licenseExpired, NEVER_EXPIRES } = require("./entitlement");

const STRIPE_REFUSAL = "This account has a paid subscription; change it in Stripe first.";
const LIFETIME_REFUSAL = "This account has a lifetime license; it isn't changed.";

/** A trial license: an end date, not lifetime/operator, no Stripe subscription. */
const isTrial = (lic) => !!(lic && lic.expires_at && !NEVER_EXPIRES(lic.plan) && !lic.stripe_subscription_id);
/** A Stripe subscription still being paid (not one Stripe ended: an ended one has grace_until and no failed payment). */
const paidStripe = (lic) => !!(lic && lic.stripe_subscription_id && !(lic.grace_until && !lic.payment_failed_at));

/**
 * What issuing `plan` to `email` would do. Never writes.
 * @returns {{ action: "create"|"create_and_link"|"upgrade"|"refuse", message?, user?, license?, from_plan?, to_plan }}
 */
async function planIssue(pool, { email, plan }) {
  const em = String(email || "").trim().toLowerCase();
  const user = (await pool.query(`SELECT id, email, email_verified, license_key_id FROM users WHERE lower(email) = $1 ORDER BY id LIMIT 1`, [em])).rows[0] || null;
  if (!user) return { action: "create", to_plan: plan };
  const u = { id: user.id, email: user.email, email_verified: !!user.email_verified };
  if (!user.license_key_id) return { action: user.email_verified ? "create_and_link" : "create", user: u, to_plan: plan };
  const lic = (await pool.query(`SELECT * FROM licenses WHERE id = $1`, [user.license_key_id])).rows[0];
  if (!lic) return { action: user.email_verified ? "create_and_link" : "create", user: u, to_plan: plan };
  const license = { id: lic.id, email: lic.email, plan: lic.plan };
  if (NEVER_EXPIRES(lic.plan)) return { action: "refuse", reason: "lifetime", message: LIFETIME_REFUSAL, user: u, license };
  if (paidStripe(lic)) return { action: "refuse", reason: "stripe", message: STRIPE_REFUSAL, user: u, license };
  return { action: "upgrade", user: u, license, from_plan: lic.plan, from_trial: isTrial(lic), to_plan: plan };
}

/**
 * Issue `plan` to `email` as planIssue decided. deps: { generateLicenseKey(plan), hashKey(key) }.
 * @returns the plan plus { license_id, license_key? (internal; a new license only) }
 */
async function issueLicense(pool, { email, plan }, { generateLicenseKey, hashKey }) {
  const em = String(email || "").trim().toLowerCase();
  const p = await planIssue(pool, { email: em, plan });
  if (p.action === "refuse") return p;
  if (p.action === "upgrade") {
    // the one change issuing makes to an existing license: the plan Jeff chose, with no end date (like any license he issues)
    await pool.query(`UPDATE licenses SET plan = $1, expires_at = NULL WHERE id = $2`, [plan, p.license.id]);
    return { ...p, license_id: p.license.id };
  }
  const key = generateLicenseKey(plan);
  const id = (await pool.query(`INSERT INTO licenses (email, plan, key_prefix, key_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [em, plan, key.slice(0, 12), await hashKey(key)])).rows[0].id;
  if (p.action === "create_and_link")
    await pool.query(`UPDATE users SET license_key_id = $1 WHERE id = $2 AND license_key_id IS NULL`, [id, p.user.id]);
  return { ...p, license_id: id, license_key: key };
}

/**
 * Link a confirmed account to the license issued to its email (see the top). Safe to call often; does nothing unless
 * there is something to do. @returns { linked: id } | { upgraded: id, from_plan, to_plan, switched_off: id } | null
 */
async function linkIssuedLicense(pool, userId, { now = Date.now(), log = console } = {}) {
  const u = (await pool.query(`SELECT id, email, email_verified, license_key_id FROM users WHERE id = $1`, [userId])).rows[0];
  if (!u || !u.email_verified) return null;                                   // never on an unconfirmed email
  const em = String(u.email || "").trim().toLowerCase();
  // the email's active licenses, newest first, that no account holds (two plain steps: there are only ever a few)
  const rows = (await pool.query(`SELECT * FROM licenses WHERE lower(email) = $1 AND active = true ORDER BY id DESC`, [em])).rows;
  let issued = null;
  for (const l of rows) {
    if (isTrial(l) || licenseExpired(l, now) || l.id === u.license_key_id) continue;
    const held = (await pool.query(`SELECT 1 FROM users WHERE license_key_id = $1 LIMIT 1`, [l.id])).rows.length;
    if (!held) { issued = l; break; }
  }
  if (!issued) return null;
  if (!u.license_key_id) {
    const r = await pool.query(`UPDATE users SET license_key_id = $1 WHERE id = $2 AND license_key_id IS NULL`, [issued.id, u.id]);
    if (r.rowCount) { log.log(`[issued-license] user ${u.id} linked to license ${issued.id} (${issued.plan}) by confirmed email`); return { linked: issued.id }; }
    return null;
  }
  const own = (await pool.query(`SELECT * FROM licenses WHERE id = $1`, [u.license_key_id])).rows[0];
  if (!own || !isTrial(own)) return null;                                    // a paid or lifetime license of its own: untouched
  // they signed in to Ether before confirming: their trial takes the issued plan (stations stay); the duplicate is switched off
  await pool.query(`UPDATE licenses SET plan = $1, expires_at = NULL WHERE id = $2`, [issued.plan, own.id]);
  await pool.query(`UPDATE licenses SET active = false WHERE id = $1`, [issued.id]);
  log.log(`[issued-license] user ${u.id}: trial license ${own.id} → ${issued.plan} (issued license ${issued.id} switched off as the unused duplicate)`);
  return { upgraded: own.id, from_plan: own.plan, to_plan: issued.plan, switched_off: issued.id };
}

module.exports = { planIssue, issueLicense, linkIssuedLicense, isTrial, paidStripe, STRIPE_REFUSAL, LIFETIME_REFUSAL };
