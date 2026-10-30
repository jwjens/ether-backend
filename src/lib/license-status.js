'use strict';
// THE PLATFORM LICENSES PAGE'S VIEW OF A LICENSE (Jeff, 2026-10-29): status, the date that applies, how it is paid, and
// the Tier dropdown in the new plan names. Read from entitlementsFor — the same rules every cloud route and the desktop
// sign-in use — so the page can never say something the server does not do. Display only: nothing here writes a license.
const { entitlementsFor } = require("./entitlements");
const { NEVER_EXPIRES } = require("./entitlement");

// The Tier dropdown: the catalog's plans plus Lifetime. A choice writes one of the plan keys the server accepts
// (VALID_PLANS) and the desktop understands (usePlan.tsx), exactly as the dropdown always has. Unlimited is its own key
// (Jeff, 2026-10-29), renewing and expiring like the other paid plans — never operator, which never expires.
const TIER_WRITES = { local: "free", station: "station", pro: "pro", unlimited: "unlimited", lifetime: "station_lifetime" };

/** Old plan key → the dropdown choice it is now, as the server's rules read it. */
function tierChoiceOf(plan) {
  const p = String(plan || "");
  if (NEVER_EXPIRES(p)) return "lifetime";          // pro_lifetime, station_lifetime, operator: Unlimited level, forever
  if (p === "free" || p === "local") return "local"; // Founding Local
  if (TIER_WRITES[p] !== undefined) return p;        // station, pro, unlimited
  return null;
}

function tierOptions(catalog) {
  return Object.keys(TIER_WRITES).map((k) => ({
    key: k,
    label: k === "lifetime" ? "Lifetime" : catalog.plans[k].label,
    writes: TIER_WRITES[k],
  }));
}

const DAY = 86400000;
/**
 * @param lic  licenses row (id, plan, active, expires_at, stripe_subscription_id)
 * @param sub  the Stripe subscription, when it has one and Stripe answered: { status, current_period_end, cancel_at_period_end }
 */
function licenseStatus(lic, { catalog, now = Date.now(), sub = null, exemptIds } = {}) {
  const e = entitlementsFor(lic, { catalog, now, ...(exemptIds ? { exemptIds } : {}) });
  const stripe = !!lic.stripe_subscription_id;
  const out = { status: null, label: "", days_left: null, date_kind: null, date: null,
                paid_through: stripe ? "stripe" : null, next_charge: null, tier_choice: tierChoiceOf(lic.plan) };

  if (e.status === "trial") {
    const days = Math.max(0, Math.ceil((new Date(e.trial_ends_at).getTime() - now) / DAY));
    Object.assign(out, { status: "trial", label: `Trial · ${days} day${days === 1 ? "" : "s"} left`, days_left: days,
                         date_kind: "trial_ends", date: e.trial_ends_at });
  } else if (e.status === "grace") {
    Object.assign(out, { status: "grace", label: "Grace", date_kind: "expires", date: e.trial_ends_at, grace_until: e.grace_until });
  } else if (e.status === "lapsed") {
    Object.assign(out, { status: "lapsed", label: "Lapsed", date_kind: "expires", date: e.trial_ends_at });
  } else if (e.status === "exempt") {
    out.status = NEVER_EXPIRES(lic.plan) ? "lifetime" : "exempt";
    out.label = out.status === "lifetime" ? "Lifetime" : "Outside plans";
  } else if (e.status === "active" && String(lic.plan) === "free") {
    // the old free key (Jeff, 2026-10-29: "Free (old key)"): no charge and never lapses, so never shown as Paid
    Object.assign(out, { status: "free_old", label: "Free (old key)" });
  } else if (e.status === "active") {
    Object.assign(out, { status: "paid", label: "Paid" });
  } else if (e.status === "inactive") {
    Object.assign(out, { status: "off", label: "Off" });
  } else {
    Object.assign(out, { status: "unknown", label: "Unknown plan" });
  }

  // A Stripe subscription's own dates: it renews on current_period_end, or ends then if it is set to cancel.
  if (stripe && sub && sub.current_period_end && out.status !== "lifetime") {
    const end = new Date(sub.current_period_end * 1000).toISOString();
    const charging = !sub.cancel_at_period_end && (sub.status === "active" || sub.status === "trialing" || sub.status === "past_due");
    if (charging) out.next_charge = end;
    if (out.status === "paid") { out.date_kind = charging ? "renews" : "expires"; out.date = end; }
  }
  return out;
}

module.exports = { licenseStatus, tierChoiceOf, tierOptions, TIER_WRITES };
