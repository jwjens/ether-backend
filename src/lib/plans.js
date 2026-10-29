'use strict';
// THE PLAN CATALOG (docs/paywall-entitlements-plan.md §4.2, desktop repo). Every price, plan name, limit and which plan
// carries which cloud feature lives in config/plans.json, and only there. Website, signup, dashboard and desktop read it
// from GET /public/plans; the server reads it to decide cloud features (entitlements.js). Validated at load: a bad
// catalog stops the server at boot instead of selling the wrong thing.
const fs = require("fs");
const path = require("path");

const PLAN_KEYS = ["local", "station", "pro", "unlimited"];

function validate(c) {
  const errs = [];
  const num = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!c || typeof c !== "object") return ["catalog is not an object"];
  if (!Number.isInteger(c.version)) errs.push("version");
  if (!c.trial || !num(c.trial.days) || !PLAN_KEYS.includes(c.trial.level)) errs.push("trial");
  for (const k of PLAN_KEYS) {
    const p = c.plans && c.plans[k];
    if (!p) { errs.push(`plans.${k} missing`); continue; }
    if (typeof p.label !== "string" || !p.label) errs.push(`plans.${k}.label`);
    if (!num(p.price_monthly)) errs.push(`plans.${k}.price_monthly`);
    if (typeof p.cloud !== "boolean") errs.push(`plans.${k}.cloud`);
  }
  for (const k of Object.keys(c.plans || {})) if (!PLAN_KEYS.includes(k)) errs.push(`plans.${k}: unknown plan`);
  for (const [f, d] of Object.entries(c.features || {})) {
    if (!Array.isArray(d.plans) || d.plans.some(p => !PLAN_KEYS.includes(p))) errs.push(`features.${f}.plans`);
    // a plan with no cloud never carries a cloud-only feature; Local's are the listener page + now-playing (Decision 2)
  }
  if (!c.features || !Object.keys(c.features).length) errs.push("features");
  return errs;
}

function load(file = path.join(__dirname, "..", "..", "config", "plans.json")) {
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  const errs = validate(c);
  if (errs.length) throw new Error(`config/plans.json invalid: ${errs.join("; ")}`);
  return Object.freeze(c);
}

/** What GET /public/plans serves: the catalog, plus which Stripe prices are set up (never the ids or variable names). */
function publicCatalog(c, env = process.env) {
  const { stripe_price_env, source, ...rest } = c;
  const purchasable = {};
  for (const [k, v] of Object.entries(stripe_price_env || {})) purchasable[k] = !!env[v];
  return { ...rest, purchasable };
}

/** Stripe price id → { plan|addon, period }, from the Railway variables the catalog names. */
function priceIndex(c, env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(c.stripe_price_env || {})) {
    if (!env[v]) continue;
    const m = /^(.+)_(monthly|annual)$/.exec(k);
    out[env[v]] = { key: m[1], period: m[2] };
  }
  return out;
}

module.exports = { PLAN_KEYS, validate, load, publicCatalog, priceIndex };
