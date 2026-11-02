'use strict';
// src/lib/entitlement.js — the account-level entitlement the signup page and /api/user/desktop-activate read (P0 B6).
//
// B6: this used to check only licenses.active, never licenses.expires_at, so a trial license linked to the account
// (desktop-activate mints one with expires_at = the trial end) read "active" forever after the trial ended. Key-based
// calls already enforce expiry (lookupLicense); now this agrees with them.
//
// LIFETIME AND OPERATOR PLANS NEVER EXPIRE here — the same rule the desktop applies (TrialGate.tsx:22-27). It also keeps
// the lifetime licenses that carry a stale expires_at (decision 8 in docs/paywall-entitlements-plan.md: PENDING, do
// not touch) reading exactly as they did before this change.
//
// This is the account page's view only. It gates nothing in playout (lapse rule): the desktop never reads it to run.

const NEVER_EXPIRES = (plan) => /_lifetime$/.test(String(plan || "")) || plan === "operator";

/** True when a license row's expires_at is in the past and its plan is one that can expire. */
function licenseExpired(row, now = Date.now()) {
  if (!row || !row.expires_at || NEVER_EXPIRES(row.plan)) return false;
  return new Date(row.expires_at).getTime() < now;
}

/** { status: active|trial|expired|none, plan, trial_days_left } for a users row. */
async function userEntitlement(pool, u, now = Date.now()) {
  if (u.license_key_id) {
    const { rows } = await pool.query(`SELECT plan, active, expires_at, stripe_subscription_id, grace_until, payment_failed_at FROM licenses WHERE id = $1`, [u.license_key_id]);
    const lic = rows[0];
    if (lic && lic.active && !licenseExpired(lic, now)) {
      // A future expires_at with no Stripe subscription is the trial key desktop-activate mints (expires_at = trial end;
      // nothing writes expires_at on a paid license). It read "active", so the account page said "Subscribed" and hid
      // the plans from every trial user (2026-11-01). It is a trial, with its days left — the same rule as entitlements.js.
      if (lic.expires_at && !NEVER_EXPIRES(lic.plan) && !lic.stripe_subscription_id) {
        const ms = new Date(lic.expires_at).getTime() - now;
        return { status: "trial", plan: "trial", trial_days_left: Math.ceil(ms / 86400000) };
      }
      // A subscription Stripe ENDED (grace_until set, no failed payment — 2026-11-01): the account page must offer the
      // plans again, so it is "ended", never "active". A failed payment stays "active" (its way back is Update card).
      if (lic.grace_until && !lic.payment_failed_at && !NEVER_EXPIRES(lic.plan)) {
        return { status: "ended", plan: lic.plan, trial_days_left: 0 };
      }
      return { status: "active", plan: lic.plan, trial_days_left: 0 };
    }
  }
  if (u.trial_ends_at) {
    const ms = new Date(u.trial_ends_at).getTime() - now;
    if (ms > 0) return { status: "trial", plan: "trial", trial_days_left: Math.ceil(ms / 86400000) };
    return { status: "expired", plan: null, trial_days_left: 0 };
  }
  return { status: "none", plan: null, trial_days_left: 0 };
}

module.exports = { userEntitlement, licenseExpired, NEVER_EXPIRES };
