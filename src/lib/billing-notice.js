'use strict';
// THE ONE BILLING NOTICE an account sees (docs/billing-notices-today-2026-10-31.md, desktop repo). One pure function:
// a licenses row (or, before the desktop was ever activated, the users row and its trial) + the catalog + now → the
// single most important notice, or null. The desktop (/account/connect billing_notice), the dashboard
// (GET /api/account/billing notice), the account site (/api/user/me account.billing_notice) and the billing emails all
// read this, so they never disagree.
//
// THE LAPSE RULE (docs/paywall-entitlements-plan.md, binding): a notice is a banner or an email, nothing else. It never
// stops audio or playout and it is never a blocking screen. Every notice says so in plain words.
//
// DATES are not worked out here: trial end, grace and lapsed come from entitlementsFor (src/lib/entitlements.js) — the
// same rules every cloud route uses. The only dates of its own are the stored card's expiry (end of its expiry month)
// and the day a payment failed.
//
// EXEMPT (lifetime, operator, the platform-created licenses in TIER_EXEMPT_LICENSE_IDS): always null. A switched-off
// license (active = false) or an unknown plan: null.
const { entitlementsFor, exemptIdsFromEnv } = require("./entitlements");

const DAY = 86400000;
// Highest first. Only the first that applies is shown.
const PRIORITY = ["lapsed", "grace", "payment_failed", "card_expired", "trial_ended", "trial_ending", "card_expiring"];
const TRIAL_ENDING_DAYS = 3;
const CARD_EXPIRING_DAYS = 30;
const PLAYOUT_LINE = "Your station keeps playing — billing never stops audio or playout.";

const fmtDay = (ms) => new Date(ms).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
const fmtMonth = (ms) => new Date(ms).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const iso = (ms) => new Date(ms).toISOString();
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The first moment after the card's expiry month (a card is good through the last day of that month), or null. */
function cardExpiryEnd(lic) {
  const m = Number(lic && lic.card_exp_month), y = Number(lic && lic.card_exp_year);
  if (!Number.isInteger(m) || !Number.isInteger(y) || m < 1 || m > 12 || y < 2000) return null;
  return Date.UTC(y, m, 1);   // month is 1-based: Date.UTC(y, m, 1) is the 1st of the NEXT month
}
function cardName(lic) {
  const brand = lic.card_brand ? String(lic.card_brand).replace(/^\w/, (c) => c.toUpperCase()) : "Card";
  return lic.card_last4 ? `${brand} ending ${lic.card_last4}` : "card on file";
}

/**
 * @param {object} a
 * @param {object|null} a.license  licenses row: id, plan, active, expires_at, stripe_subscription_id, stripe_customer_id,
 *                                 payment_failed_at, card_brand, card_last4, card_exp_month, card_exp_year
 * @param {object|null} a.user     users row (trial_ends_at), used only when there is no license yet
 * @param {object} a.catalog       config/plans.json
 * @param {string} [a.accountUrl]  the account site (ACCOUNT_APP_URL) — "Add a card" / "Update card" go there
 * @returns {null | { kind, title, body, action:{label,url,portal}, severity, endsAt?, daysLeft?, period_key, started_at }}
 */
function billingNotice({ license = null, user = null, catalog, now = Date.now(), exemptIds = exemptIdsFromEnv(), accountUrl = "https://ether-technologies.com" } = {}) {
  let lic = license;
  if (!lic) {
    // An account that never activated the desktop has no license; its trial is the users row's (signup + 15 days).
    if (!user || !user.trial_ends_at) return null;
    lic = { id: 0, plan: catalog.trial.level, active: true, expires_at: user.trial_ends_at };
  }
  const ent = entitlementsFor(lic, { catalog, now, exemptIds });
  if (!["trial", "grace", "lapsed", "active"].includes(ent.status)) return null;   // exempt, inactive, none

  const customer = !!(lic.stripe_subscription_id || lic.stripe_customer_id);
  const base = String(accountUrl || "").replace(/\/$/, "");
  const action = customer
    ? { label: "Update card", url: `${base}/?billing=update-card`, portal: true }
    : { label: "Add a card", url: `${base}/?billing=add-card`, portal: false };
  const cloud = "cloud features (hosted stream, web dashboard, sync, cloud backup)";
  const found = {};

  const end = ent.trial_ends_at ? new Date(ent.trial_ends_at).getTime() : null;
  const graceUntil = ent.grace_until ? new Date(ent.grace_until).getTime() : null;

  if (ent.status === "lapsed") {
    found.lapsed = {
      severity: "error", endsAt: iso(graceUntil), period_key: isoDay(end), started_at: iso(graceUntil),
      title: customer ? "Your plan has lapsed" : "Your free trial has ended",
      body: `${customer ? "Your plan ended" : "Your trial ended"} on ${fmtDay(end)} and the grace period ended on ${fmtDay(graceUntil)}. `
          + `${cloud[0].toUpperCase() + cloud.slice(1)} are no longer included. ${customer ? "Update your card" : "Add a card"} to turn them back on. ${PLAYOUT_LINE}`,
    };
  } else if (ent.status === "grace") {
    const days = Math.max(0, Math.ceil((graceUntil - now) / DAY));
    const k = customer ? "grace" : "trial_ended";
    found[k] = {
      severity: "warning", endsAt: iso(graceUntil), daysLeft: days, period_key: isoDay(end), started_at: iso(end),
      title: customer ? `Your plan ended — ${cloud.split(" (")[0]} included until ${fmtDay(graceUntil)}` : "Your free trial has ended",
      body: `${customer ? "Your paid period ended" : "Your 15-day trial ended"} on ${fmtDay(end)}. `
          + `${cloud[0].toUpperCase() + cloud.slice(1)} stay included until ${fmtDay(graceUntil)} (${plural(days, "day")}). `
          + `${customer ? "Update your card" : "Add a card"} to keep them. ${PLAYOUT_LINE}`,
    };
  } else if (ent.status === "trial" && !customer && end != null) {
    const days = Math.max(0, Math.ceil((end - now) / DAY));
    if (days <= TRIAL_ENDING_DAYS) {
      found.trial_ending = {
        severity: "info", endsAt: iso(end), daysLeft: days, period_key: isoDay(end), started_at: iso(end - TRIAL_ENDING_DAYS * DAY),
        title: days === 0 ? "Your free trial ends today" : `Your free trial ends in ${plural(days, "day")}`,
        body: `Your trial ends on ${fmtDay(end)}. Add a card to keep ${cloud} after that. ${PLAYOUT_LINE}`,
      };
    }
  }

  if (lic.payment_failed_at) {
    const failed = new Date(lic.payment_failed_at).getTime();
    const stops = failed + (catalog.grace.past_due_days || 0) * DAY;
    const within = now < stops;
    found.payment_failed = {
      severity: "error", ...(within ? { endsAt: iso(stops), daysLeft: Math.max(0, Math.ceil((stops - now) / DAY)) } : {}),
      period_key: isoDay(failed), started_at: iso(failed),
      title: "Your payment didn't go through",
      body: `Your card was declined on ${fmtDay(failed)}. `
          + (within ? `Update your card by ${fmtDay(stops)} to keep ${cloud}. ` : `Update your card to keep ${cloud}. `)
          + PLAYOUT_LINE,
    };
  }

  const cardEnd = customer ? cardExpiryEnd(lic) : null;
  if (cardEnd != null) {
    const last = cardEnd - DAY;   // the last day the card works
    if (now >= cardEnd) {
      found.card_expired = {
        severity: "error", endsAt: iso(cardEnd), period_key: isoDay(cardEnd).slice(0, 7), started_at: iso(cardEnd),
        title: "Your card on file has expired",
        body: `Your ${cardName(lic)} expired at the end of ${fmtMonth(last)}. Update it so your next payment goes through. ${PLAYOUT_LINE}`,
      };
    } else if (cardEnd - now <= CARD_EXPIRING_DAYS * DAY) {
      const days = Math.max(0, Math.ceil((cardEnd - now) / DAY));
      found.card_expiring = {
        severity: "info", endsAt: iso(cardEnd), daysLeft: days, period_key: isoDay(cardEnd).slice(0, 7), started_at: iso(cardEnd - CARD_EXPIRING_DAYS * DAY),
        title: "Your card expires soon",
        body: `Your ${cardName(lic)} expires at the end of ${fmtMonth(last)}. Update it so your next payment goes through. ${PLAYOUT_LINE}`,
      };
    }
  }

  const kind = PRIORITY.find((k) => found[k]);
  if (!kind) return null;
  const n = found[kind];
  return { kind, title: n.title, body: n.body, action, severity: n.severity,
           ...(n.endsAt ? { endsAt: n.endsAt } : {}), ...(n.daysLeft != null ? { daysLeft: n.daysLeft } : {}),
           period_key: n.period_key, started_at: n.started_at };
}

// Stripe Customer Portal return address: only our own sites (no open redirect). Localhost only when the caller says so
// (the local billing test server).
const PORTAL_ORIGINS = /^https:\/\/(app\.ether-cast\.com|app\.ether-technologies\.com|ether-dashboard\.pages\.dev|signup\.ether-cast\.com|signup\.ether-technologies\.com|ether-cast\.com|ether-technologies\.com)$/;
function portalReturnUrl(origin, { fallback = "https://app.ether-cast.com", allowLocalhost = false } = {}) {
  const o = String(origin || "");
  if (PORTAL_ORIGINS.test(o)) return o;
  if (allowLocalhost && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(o)) return o;
  return fallback;
}

module.exports = { billingNotice, cardExpiryEnd, portalReturnUrl, PRIORITY, TRIAL_ENDING_DAYS, CARD_EXPIRING_DAYS };
