'use strict';
// THE STRIPE PRICES THE SERVER SELLS (Jeff, 2026-11-01: docs/stripe-new-prices-steps-2026-11-01.md, desktop repo).
// Every price id comes from the environment variable config/plans.json names for it (stripe_price_env) — never from
// code — so the same server sells test prices on the local test server (.env.stripe-test) and live prices on Railway.
//
//   plan prices    local / station (Live 128) / pro (Live 320) / unlimited (Network), each monthly or annual
//   add-ons        network_extra_station (Network only, $15, +1 station and +50 listeners to the pool)
//                  listeners_50 (Live 128, Live 320, Network: +50 listeners), both bought as a quantity
//   legacy         PRICE_STATION / PRICE_PRO (the prices sold before 2026-11-01) still map to their plans, so a
//                  subscription bought on them keeps renewing into the right license.
const { priceIndex } = require("./plans");

const PLAN_KEYS = ["local", "station", "pro", "unlimited"];
const PERIODS = ["monthly", "annual"];
const ADDON_EXTRA_STATION = "network_extra_station";
const ADDON_LISTENERS = "listeners_50";
const MAX_QTY = 100;   // a typo guard, not a business limit

/** Stripe price id → { kind: "plan"|"addon", key, period }, from the variables the catalog names, plus the legacy two. */
function priceMap(catalog, env = process.env) {
  const out = {};
  for (const [id, { key, period }] of Object.entries(priceIndex(catalog, env))) {
    out[id] = { kind: PLAN_KEYS.includes(key) ? "plan" : "addon", key, period };
  }
  if (env.PRICE_STATION && !out[env.PRICE_STATION]) out[env.PRICE_STATION] = { kind: "plan", key: "station", period: "monthly", legacy: true };
  if (env.PRICE_PRO && !out[env.PRICE_PRO]) out[env.PRICE_PRO] = { kind: "plan", key: "pro", period: "monthly", legacy: true };
  return out;
}

/** Stripe price id → plan key, for plan prices only (what the webhook issues a license at). */
function planByPriceId(catalog, env = process.env) {
  const out = {};
  for (const [id, p] of Object.entries(priceMap(catalog, env))) if (p.kind === "plan") out[id] = p.key;
  return out;
}

/** Stripe price id → add-on key. */
function addonByPriceId(catalog, env = process.env) {
  const out = {};
  for (const [id, p] of Object.entries(priceMap(catalog, env))) if (p.kind === "addon") out[id] = p.key;
  return out;
}

const envName = (catalog, k) => (catalog.stripe_price_env || {})[k];
const priceId = (catalog, env, k) => { const v = envName(catalog, k); return (v && env[v]) || null; };

function qty(v, field) {
  if (v === undefined || v === null || v === "") return { n: 0 };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_QTY) return { error: `invalid_${field}` };
  return { n };
}

/** Which add-ons a plan may carry, from the catalog (extra stations: only a plan with extra_station; listeners: addons.listeners_50.plans). */
function addonsAllowed(catalog, plan) {
  const p = catalog.plans[plan] || {};
  const l = catalog.addons && catalog.addons[ADDON_LISTENERS];
  return { extra_stations: !!p.extra_station, listener_addons: !!(l && Array.isArray(l.plans) && l.plans.includes(plan)) };
}

/**
 * Stripe Checkout line items for { plan, period, extra_stations, listener_addons }.
 * → { items:[{price,quantity}], plan, period, extra_stations, listener_addons } or { error } (the route answers 400 with it).
 */
function checkoutItems(catalog, env, body = {}) {
  const plan = String(body.plan || "");
  const period = String(body.period || "monthly");
  if (!PLAN_KEYS.includes(plan)) return { error: "invalid_plan" };
  if (!PERIODS.includes(period)) return { error: "invalid_period" };
  const base = priceId(catalog, env, `${plan}_${period}`);
  if (!base) return { error: "invalid_plan" };   // the price for that plan/period is not set up (the site says so)
  const xs = qty(body.extra_stations, "extra_stations"); if (xs.error) return xs;
  const la = qty(body.listener_addons, "listener_addons"); if (la.error) return la;
  const ok = addonsAllowed(catalog, plan);
  if (xs.n && !ok.extra_stations) return { error: "extra_stations_not_on_plan" };
  if (la.n && !ok.listener_addons) return { error: "listener_addons_not_on_plan" };
  const items = [{ price: base, quantity: 1 }];
  if (xs.n) {
    const id = priceId(catalog, env, `${ADDON_EXTRA_STATION}_monthly`);
    if (!id) return { error: "addon_unavailable" };
    items.push({ price: id, quantity: xs.n });
  }
  if (la.n) {
    const id = priceId(catalog, env, `${ADDON_LISTENERS}_monthly`);
    if (!id) return { error: "addon_unavailable" };
    items.push({ price: id, quantity: la.n });
  }
  // A yearly plan and a monthly add-on cannot share one Stripe subscription (one billing interval per subscription).
  if (items.length > 1 && period !== "monthly") return { error: "addons_need_monthly" };
  return { items, plan, period, extra_stations: xs.n, listener_addons: la.n };
}

const itemPrice = (it) => (it && it.price && (typeof it.price === "string" ? it.price : it.price.id)) || "";

/** What a Stripe subscription says: its plan, and how many of each add-on. Unknown prices are listed, never guessed. */
function subscriptionState(sub, catalog, env = process.env) {
  const map = priceMap(catalog, env);
  const out = { plan: null, period: null, extra_stations: 0, listener_addons: 0, unknown_prices: [] };
  for (const it of (sub && sub.items && sub.items.data) || []) {
    const id = itemPrice(it);
    const p = map[id];
    const q = Number.isInteger(it.quantity) ? it.quantity : 1;
    if (!p) { out.unknown_prices.push(id); continue; }
    if (p.kind === "plan") { out.plan = p.key; out.period = p.period; }
    else if (p.key === ADDON_EXTRA_STATION) out.extra_stations += q;
    else if (p.key === ADDON_LISTENERS) out.listener_addons += q;
  }
  return out;
}

/**
 * The subscription.update items that bring a subscription's add-on quantities to { extra_stations, listener_addons }.
 * Existing items are re-quantified (or deleted at 0); missing ones added. → { items } or { error }.
 */
function addonUpdateItems(sub, catalog, env, want = {}) {
  const st = subscriptionState(sub, catalog, env);
  if (!st.plan) return { error: "no_plan_on_subscription" };
  const xs = qty(want.extra_stations, "extra_stations"); if (xs.error) return xs;
  const la = qty(want.listener_addons, "listener_addons"); if (la.error) return la;
  const ok = addonsAllowed(catalog, st.plan);
  if (xs.n && !ok.extra_stations) return { error: "extra_stations_not_on_plan" };
  if (la.n && !ok.listener_addons) return { error: "listener_addons_not_on_plan" };
  if ((xs.n || la.n) && st.period !== "monthly") return { error: "addons_need_monthly" };
  const map = priceMap(catalog, env);
  const items = [];
  const plan = (key, n) => {
    const existing = ((sub.items && sub.items.data) || []).find((it) => map[itemPrice(it)] && map[itemPrice(it)].key === key);
    if (existing) {
      if (n === 0) items.push({ id: existing.id, deleted: true });
      else if (existing.quantity !== n) items.push({ id: existing.id, quantity: n });
      return null;
    }
    if (n === 0) return null;
    const id = priceId(catalog, env, `${key}_monthly`);
    if (!id) return "addon_unavailable";
    items.push({ price: id, quantity: n });
    return null;
  };
  const e1 = plan(ADDON_EXTRA_STATION, xs.n); if (e1) return { error: e1 };
  const e2 = plan(ADDON_LISTENERS, la.n); if (e2) return { error: e2 };
  return { items, extra_stations: xs.n, listener_addons: la.n };
}

/**
 * How many stations a license may register in the cloud. A Network bought through Stripe (it has a subscription) is
 * capped at the catalog's stations_included plus its paid extra stations; every other license keeps the cap it had
 * (baseCaps, PLAN_STATION_LIMITS in index.js) — lifetime, platform-made and older licenses are never re-limited.
 */
function stationCapFor(license, baseCaps, catalog) {
  const plan = license && license.plan;
  const p = catalog.plans[plan];
  if (license && license.stripe_subscription_id && p && Number.isInteger(p.stations_included)) {
    return p.stations_included + Math.max(0, Number(license.extra_stations) || 0);
  }
  return baseCaps[plan] ?? baseCaps.free;
}

module.exports = {
  PLAN_KEYS, PERIODS, ADDON_EXTRA_STATION, ADDON_LISTENERS,
  priceMap, planByPriceId, addonByPriceId, checkoutItems, subscriptionState, addonUpdateItems, addonsAllowed, stationCapFor,
};
