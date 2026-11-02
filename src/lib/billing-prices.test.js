'use strict';
// The Stripe prices the server sells (2026-11-01): price ids from env, checkout line items, add-on quantities, the
// webhook's plan line, the license limits and the Network station cap.
//   node --test src/lib/billing-prices.test.js
const test = require("node:test");
const assert = require("node:assert");
const { newDb } = require("pg-mem");
const B = require("./billing-prices");
const W = require("./stripe-webhook");
const ENT = require("./entitlements");
const CATALOG = require("./plans").load();

const ENV = {
  PRICE_LOCAL_MONTHLY: "price_lm", PRICE_LOCAL_ANNUAL: "price_la",
  PRICE_STATION_MONTHLY: "price_sm", PRICE_STATION_ANNUAL: "price_sa",
  PRICE_PRO_MONTHLY: "price_pm", PRICE_PRO_ANNUAL: "price_pa",
  PRICE_UNLIMITED_MONTHLY: "price_um", PRICE_UNLIMITED_ANNUAL: "price_ua",
  PRICE_NETWORK_EXTRA_STATION_MONTHLY: "price_xs", PRICE_LISTENERS_50_MONTHLY: "price_l50",
  PRICE_STATION: "price_old_station", PRICE_PRO: "price_old_pro",
};

test("every price id comes from the env variable the catalog names; plans and add-ons are told apart; the old PRICE_STATION / PRICE_PRO are not read", () => {
  const plans = B.planByPriceId(CATALOG, ENV);
  assert.deepStrictEqual(plans, {
    price_lm: "local", price_la: "local", price_sm: "station", price_sa: "station", price_pm: "pro", price_pa: "pro",
    price_um: "unlimited", price_ua: "unlimited",
  });
  assert.deepStrictEqual(B.addonByPriceId(CATALOG, ENV), { price_xs: "network_extra_station", price_l50: "listeners_50" });
  assert.deepStrictEqual(B.planByPriceId(CATALOG, {}), {}, "no env → nothing sold (no hardcoded id)");
});

test("checkout: each plan monthly and yearly → its one price", () => {
  for (const [plan, m, a] of [["local", "price_lm", "price_la"], ["station", "price_sm", "price_sa"], ["pro", "price_pm", "price_pa"], ["unlimited", "price_um", "price_ua"]]) {
    assert.deepStrictEqual(B.checkoutItems(CATALOG, ENV, { plan }).items, [{ price: m, quantity: 1 }]);
    assert.deepStrictEqual(B.checkoutItems(CATALOG, ENV, { plan, period: "annual" }).items, [{ price: a, quantity: 1 }]);
  }
});

test("checkout: add-ons as quantities, only on the plans the catalog allows, monthly only", () => {
  assert.deepStrictEqual(B.checkoutItems(CATALOG, ENV, { plan: "unlimited", extra_stations: 2, listener_addons: 1 }).items,
    [{ price: "price_um", quantity: 1 }, { price: "price_xs", quantity: 2 }, { price: "price_l50", quantity: 1 }]);
  assert.deepStrictEqual(B.checkoutItems(CATALOG, ENV, { plan: "pro", listener_addons: 3 }).items,
    [{ price: "price_pm", quantity: 1 }, { price: "price_l50", quantity: 3 }]);
  assert.strictEqual(B.checkoutItems(CATALOG, ENV, { plan: "station", extra_stations: 1 }).error, "extra_stations_not_on_plan");
  assert.strictEqual(B.checkoutItems(CATALOG, ENV, { plan: "local", listener_addons: 1 }).error, "listener_addons_not_on_plan");
  assert.strictEqual(B.checkoutItems(CATALOG, ENV, { plan: "unlimited", period: "annual", extra_stations: 1 }).error, "addons_need_monthly");
  assert.strictEqual(B.checkoutItems(CATALOG, ENV, { plan: "unlimited", extra_stations: -1 }).error, "invalid_extra_stations");
  assert.strictEqual(B.checkoutItems(CATALOG, ENV, { plan: "unlimited", extra_stations: 1.5 }).error, "invalid_extra_stations");
});

test("checkout: unknown plan, unknown period, or a price that is not set up → refused, nothing guessed", () => {
  assert.strictEqual(B.checkoutItems(CATALOG, ENV, { plan: "operator" }).error, "invalid_plan");
  assert.strictEqual(B.checkoutItems(CATALOG, ENV, { plan: "pro", period: "weekly" }).error, "invalid_period");
  assert.strictEqual(B.checkoutItems(CATALOG, { PRICE_PRO: "price_old_pro" }, { plan: "pro" }).error, "invalid_plan",
    "the old PRICE_PRO is neither sold nor mapped");
  assert.strictEqual(B.checkoutItems(CATALOG, { PRICE_UNLIMITED_MONTHLY: "price_um" }, { plan: "unlimited", extra_stations: 1 }).error, "addon_unavailable");
});

const sub = (items, id = "sub_1") => ({ id, object: "subscription", items: { data: items.map(([price, quantity], i) => ({ id: `si_${i}`, price: { id: price }, quantity })) } });

test("subscription state: plan, period and add-on counts; an unknown price is listed, not guessed", () => {
  assert.deepStrictEqual(B.subscriptionState(sub([["price_xs", 2], ["price_um", 1], ["price_l50", 1], ["price_zzz", 1]]), CATALOG, ENV),
    { plan: "unlimited", period: "monthly", extra_stations: 2, listener_addons: 1, unknown_prices: ["price_zzz"] });
});

test("add-on update: re-quantifies, adds, deletes at 0; refuses on a yearly plan or a plan without the add-on", () => {
  const s = sub([["price_um", 1], ["price_xs", 1]]);
  assert.deepStrictEqual(B.addonUpdateItems(s, CATALOG, ENV, { extra_stations: 1, listener_addons: 1 }).items, [{ price: "price_l50", quantity: 1 }]);
  assert.deepStrictEqual(B.addonUpdateItems(s, CATALOG, ENV, { extra_stations: 3, listener_addons: 0 }).items, [{ id: "si_1", quantity: 3 }]);
  assert.deepStrictEqual(B.addonUpdateItems(s, CATALOG, ENV, { extra_stations: 0, listener_addons: 0 }).items, [{ id: "si_1", deleted: true }]);
  assert.strictEqual(B.addonUpdateItems(sub([["price_ua", 1]]), CATALOG, ENV, { extra_stations: 1 }).error, "addons_need_monthly");
  assert.strictEqual(B.addonUpdateItems(sub([["price_sm", 1]]), CATALOG, ENV, { extra_stations: 1 }).error, "extra_stations_not_on_plan");
});

test("station cap: a Stripe Network = 5 + paid extras; every other license keeps the cap it had", () => {
  const BASE = { free: 1, station: 5, unlimited: -1, station_lifetime: 5 };
  assert.strictEqual(B.stationCapFor({ plan: "unlimited", stripe_subscription_id: "sub_1", extra_stations: 2 }, BASE, CATALOG), 7);
  assert.strictEqual(B.stationCapFor({ plan: "unlimited", stripe_subscription_id: "sub_1" }, BASE, CATALOG), 5);
  assert.strictEqual(B.stationCapFor({ plan: "unlimited" }, BASE, CATALOG), -1, "a platform-made Network is not re-limited");
  assert.strictEqual(B.stationCapFor({ plan: "station_lifetime", stripe_subscription_id: null }, BASE, CATALOG), 5);
  assert.strictEqual(B.stationCapFor({ plan: "station", stripe_subscription_id: "sub_2" }, BASE, CATALOG), 5);
  assert.strictEqual(B.stationCapFor({ plan: "weird" }, BASE, CATALOG), 1);
});

test("limits: Network extra stations and +50 listeners raise the pool and the station count; Live adds per stream", () => {
  const now = Date.now();
  const net = ENT.entitlementsFor({ id: 1, plan: "unlimited", active: true, extra_stations: 1, listener_addons: 1 }, { catalog: CATALOG, now, exemptIds: new Set() });
  assert.deepStrictEqual(net.limits.listeners, { mode: "pool", pool: 350 });
  assert.strictEqual(net.limits.stations_included, 6);
  assert.strictEqual(net.limits.hosted_streams, 6);
  assert.deepStrictEqual(net.limits.addons, { extra_stations: 1, listener_addons: 1 });
  const live = ENT.entitlementsFor({ id: 2, plan: "pro", active: true, listener_addons: 2 }, { catalog: CATALOG, now, exemptIds: new Set() });
  assert.deepStrictEqual(live.limits.listeners, { mode: "per_stream", per_stream: 250 });
  const plain = ENT.entitlementsFor({ id: 3, plan: "unlimited", active: true }, { catalog: CATALOG, now, exemptIds: new Set() });
  assert.deepStrictEqual(plain.limits.listeners, { mode: "pool", pool: 250 });
  assert.strictEqual(plain.limits.addons, undefined);
  const life = ENT.entitlementsFor({ id: 4, plan: "station_lifetime", active: true, extra_stations: 3 }, { catalog: CATALOG, now, exemptIds: new Set() });
  assert.deepStrictEqual(life.limits.listeners, { mode: "pool", pool: 250 }, "lifetime limits are frozen; add-ons never apply");
  const local = ENT.entitlementsFor({ id: 5, plan: "local", active: true }, { catalog: CATALOG, now, exemptIds: new Set() });
  assert.strictEqual(local.label, "Local");
  assert.strictEqual(local.status, "active");
});

// ── the webhook ────────────────────────────────────────────────────────────────────────────────────────────────
async function freshPool() {
  const pool = new (newDb().adapters.createPg().Pool)();
  await pool.query(`CREATE TABLE licenses (
    id SERIAL PRIMARY KEY, license_key TEXT, email TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL,
    stripe_customer_id TEXT, stripe_subscription_id TEXT, expires_at TIMESTAMPTZ, active BOOLEAN DEFAULT true,
    key_prefix TEXT, key_hash TEXT, payment_failed_at TIMESTAMPTZ, grace_until TIMESTAMPTZ, card_brand TEXT, card_last4 TEXT,
    card_exp_month INTEGER, card_exp_year INTEGER, extra_stations INTEGER DEFAULT 0, listener_addons INTEGER DEFAULT 0)`);
  await pool.query(`CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT NOT NULL, license_key_id INTEGER)`);
  return pool;
}
const deps = (pool, over = {}) => ({
  pool, validPlans: new Set(["local", "station", "pro", "unlimited"]), planByPriceId: B.planByPriceId(CATALOG, ENV),
  subscriptionState: (s) => B.subscriptionState(s, CATALOG, ENV),
  generateLicenseKey: (plan) => `ETH-${plan}-AAAA`, hashKey: async (k) => `hash:${k}`, sendLicenseEmail: async () => {},
  log: { log() {}, warn() {}, error() {} }, ...over,
});
const ev = (type, object) => ({ type, data: { object } });

test("webhook: an invoice whose first line is an add-on still issues at the plan (the plan line is found)", async () => {
  const pool = await freshPool();
  await W.handlePlatformEvent(ev("invoice.payment_succeeded", {
    customer_email: "n@x.com", subscription: "sub_n", customer: "cus_n",
    lines: { data: [{ price: { id: "price_xs" } }, { price: { id: "price_um" } }] },
  }), deps(pool));
  assert.strictEqual((await pool.query(`SELECT plan FROM licenses`)).rows[0].plan, "unlimited");
});

test("webhook: subscription.created/updated set the plan from the plan item (not item 0) and record the add-ons", async () => {
  const pool = await freshPool();
  await pool.query(`INSERT INTO licenses (email, plan, stripe_subscription_id) VALUES ('n@x.com','unlimited','sub_1')`);
  await W.handlePlatformEvent(ev("customer.subscription.updated", { ...sub([["price_xs", 1], ["price_um", 1]]), status: "active" }), deps(pool));
  let r = (await pool.query(`SELECT plan, extra_stations, listener_addons FROM licenses`)).rows[0];
  assert.deepStrictEqual(r, { plan: "unlimited", extra_stations: 1, listener_addons: 0 });
  await W.handlePlatformEvent(ev("customer.subscription.created", { ...sub([["price_um", 1], ["price_xs", 1], ["price_l50", 1]]), status: "active" }), deps(pool));
  r = (await pool.query(`SELECT plan, extra_stations, listener_addons FROM licenses`)).rows[0];
  assert.deepStrictEqual(r, { plan: "unlimited", extra_stations: 1, listener_addons: 1 });
});

test("webhook: a finished checkout reads the subscription from Stripe for its add-ons; Stripe unreachable → 503, nothing written, the redelivery makes it", async () => {
  const pool = await freshPool();
  await pool.query(`INSERT INTO users (email) VALUES ('n@x.com')`);
  const stripe = { subscriptions: { retrieve: async (id) => sub([["price_um", 1], ["price_xs", 2]], id) }, customers: { retrieve: async () => ({ deleted: true }) } };
  const out = await W.handlePlatformEvent(ev("checkout.session.completed", {
    mode: "subscription", client_reference_id: "1", customer_email: "n@x.com", metadata: { plan: "unlimited" }, subscription: "sub_9", customer: "cus_9",
  }), deps(pool, { stripe }));
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual((await pool.query(`SELECT plan, extra_stations FROM licenses`)).rows[0], { plan: "unlimited", extra_stations: 2 });

  const pool2 = await freshPool();
  await pool2.query(`INSERT INTO users (email) VALUES ('n@x.com')`);
  const bad = { subscriptions: { retrieve: async () => { throw new Error("boom"); } }, customers: { retrieve: async () => ({ deleted: true }) } };
  const out2 = await W.handlePlatformEvent(ev("checkout.session.completed", {
    mode: "subscription", client_reference_id: "1", customer_email: "n@x.com", metadata: { plan: "local" }, subscription: "sub_8",
  }), deps(pool2, { stripe: bad }));
  assert.strictEqual(out2.status, 503, "Stripe could not be read: Stripe is told to deliver it again");
  assert.strictEqual((await pool2.query(`SELECT COUNT(*)::int n FROM licenses`)).rows[0].n, 0, "nothing written");
  const good = { subscriptions: { retrieve: async (id) => sub([["price_lm", 1]], id) }, customers: { retrieve: async () => ({ deleted: true }) } };
  const out3 = await W.handlePlatformEvent(ev("checkout.session.completed", {
    mode: "subscription", client_reference_id: "1", customer_email: "n@x.com", metadata: { plan: "local" }, subscription: "sub_8",
  }), deps(pool2, { stripe: good }));
  assert.strictEqual(out3.status, 200);
  assert.deepStrictEqual((await pool2.query(`SELECT plan, extra_stations FROM licenses`)).rows[0], { plan: "local", extra_stations: 0 });
});

test("wired: index.js builds the price map from billing-prices, sells from env, and has no hardcoded price id", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "index.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /const PLAN_BY_PRICE_ID = BILLING\.planByPriceId\(PLAN_CATALOG\);/);
  assert.match(src, /BILLING\.checkoutItems\(PLAN_CATALOG, process\.env, req\.body \|\| \{\}\)/);
  assert.match(src, /subscriptionState: \(sub\) => BILLING\.subscriptionState\(sub, PLAN_CATALOG\)/);
  assert.doesNotMatch(src, /["']price_[A-Za-z0-9]{8,}["']/, "no Stripe price id literal in the server");
  assert.match(src, /"local",\n\]\);/);
});

test("nothing in the server reads the old PRICE_STATION / PRICE_PRO any more (safe to remove from Railway)", () => {
  const fs = require("node:fs"), path = require("node:path");
  const files = ["index.js", "lib/billing-prices.js", "lib/stripe-webhook.js", "lib/plans.js"].map((f) => path.join(__dirname, "..", f));
  for (const f of files) {
    const code = fs.readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    assert.doesNotMatch(code, /process\.env\.PRICE_(STATION|PRO)\b|env\.PRICE_(STATION|PRO)\b/, `${path.basename(f)} reads an old price variable`);
  }
  assert.deepStrictEqual(Object.keys(B.priceMap(CATALOG, { PRICE_STATION: "price_s", PRICE_PRO: "price_p" })), [], "the old ones map to nothing");
});
