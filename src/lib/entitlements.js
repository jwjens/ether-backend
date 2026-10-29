'use strict';
// WHAT A LICENSE MAY USE (docs/paywall-entitlements-plan.md §4.3, desktop repo). One pure function: a licenses row + the
// catalog + now → the account's plan, its status and its cloud features. The server reads it on every cloud route
// (requireFeature) and hands it to the desktop at sign-in, so the two never disagree.
//
// THE LAPSE RULE: this decides CLOUD features only. Nothing local (audio, playout, scheduling, logging, startup) reads
// it. A lapsed Local license means a reminder banner and no new updates; nothing else.
//
// RULINGS (2026-10-05 R1–R3, 2026-10-29), applied in code, never by writing a license row:
//   · lifetime and operator licenses: Unlimited-level forever; expires_at ignored. Never modified or re-mapped.
//   · licenses listed in TIER_EXEMPT_LICENSE_IDS (made in the platform app): outside the tier system — exactly today's
//     access, no trial, no lapse, no banner.
//   · active = false is an operator's explicit off switch, not a lapse: no cloud.
//
// LEGACY PLAN KEYS (rows written before the 2026-10-29 catalog), mapped HERE ONLY, until P6 migration is decided:
//   free → Local, "Founding Local" (Decision 6: no charge; never lapses).
//   pro / station: the old keys have the SAME NAMES as the new Pro and Station plans, so a row cannot say which it is.
//     They read as the new plan of that name: with an expires_at, a trial (full access until it ends, then the grace,
//     then Local lapsed); without one, that plan active. Per the 2026-10-05 audit no active license is on `pro`; an old
//     paid `station` keeps cloud at Station level. The P6 migration decides any re-pricing.
const { NEVER_EXPIRES } = require("./entitlement");

function exemptIdsFromEnv(env = process.env) {
  return new Set(String(env.TIER_EXEMPT_LICENSE_IDS || "").split(",").map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0));
}

function featuresOf(catalog, planKey) {
  const out = {};
  for (const [f, d] of Object.entries(catalog.features)) out[f] = !!planKey && d.plans.includes(planKey);
  return out;
}
function limitsOf(catalog, planKey) {
  const p = catalog.plans[planKey] || {};
  return {
    hosted_streams: p.hosted_streams ?? 0,
    max_bitrate_kbps: p.max_bitrate_kbps ?? null,
    listeners: p.listener_pool != null ? { mode: "pool", pool: p.listener_pool }
             : p.listeners_per_stream != null ? { mode: "per_stream", per_stream: p.listeners_per_stream } : null,
    r2_quota_gb: p.r2_quota_gb ?? null,
    priority_support: !!p.priority_support,
  };
}

/**
 * @param {object|null} lic  licenses row (id, plan, active, expires_at)
 * @returns {{ license_id, plan, label, level, status, cloud, features, limits, trial_ends_at, legacy, exempt, catalog_version }}
 *   plan   = the catalog plan the account is ON (what the customer sees)
 *   level  = the catalog plan whose features apply right now (a trial runs at the trial level)
 *   status = active | trial | grace (ended, cloud still on until grace_until) | lapsed | exempt | inactive | none
 */
function entitlementsFor(lic, { catalog, now = Date.now(), exemptIds = exemptIdsFromEnv() } = {}) {
  const base = { license_id: lic ? Number(lic.id) : null, trial_ends_at: null, grace_until: null, legacy: false, exempt: false, catalog_version: catalog.version };
  const result = (plan, level, status, extra = {}) => {
    const cloudLevel = level && catalog.plans[level] && catalog.plans[level].cloud ? level : null;
    return {
      ...base, plan, label: plan ? catalog.plans[plan].label : null, level, status,
      cloud: !!cloudLevel, features: featuresOf(catalog, level), limits: limitsOf(catalog, level), ...extra,
    };
  };
  if (!lic) return result(null, null, "none");
  if (lic.active === false) return result(null, null, "inactive");

  const plan = String(lic.plan || "");
  if (NEVER_EXPIRES(plan)) return result("unlimited", "unlimited", "exempt", { exempt: true, legacy: true });
  if (exemptIds.has(Number(lic.id))) {
    // outside the tier system: exactly today's access (a paid plan key has every cloud feature; free has none)
    const level = plan === "free" || plan === "local" ? "local" : "unlimited";
    return result(level === "local" ? "local" : "unlimited", level, "exempt", { exempt: true, legacy: true });
  }

  const ends = lic.expires_at ? new Date(lic.expires_at).getTime() : null;
  const live = ends == null || ends > now;
  const trialEnds = ends != null ? new Date(ends).toISOString() : null;
  // cloud features stop only after the grace period (Jeff, 2026-10-29); until then the account runs at the level it had
  const graceMs = (catalog.grace.past_due_days || 0) * 86400000;
  const inGrace = ends != null && !live && now < ends + graceMs;
  const graceUntil = ends != null ? new Date(ends + graceMs).toISOString() : null;

  if (plan === "free") return result("local", "local", "active", { legacy: true });   // Founding Local (Decision 6)
  if (catalog.plans[plan]) {
    // a current plan key: an expires_at on it is a trial (or a paid period's end); past it, Local lapsed
    if (ends != null && live) return result(plan, catalog.trial.level, "trial", { trial_ends_at: trialEnds, grace_until: graceUntil });
    if (inGrace) return result(plan, catalog.trial.level, "grace", { trial_ends_at: trialEnds, grace_until: graceUntil });
    if (!live) return result(plan, null, "lapsed", { trial_ends_at: trialEnds, grace_until: graceUntil });
    return result(plan, plan, "active");
  }
  return result(null, null, "none");   // an unknown plan key: no cloud, and the account page says so
}

/** May this license use cloud feature `f` right now? */
function allows(ent, f) { return !!(ent && ent.features && ent.features[f]); }

module.exports = { entitlementsFor, allows, exemptIdsFromEnv };
