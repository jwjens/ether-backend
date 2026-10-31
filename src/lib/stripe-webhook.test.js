'use strict';
// P0 billing blockers — the platform Stripe webhook against real SQL (pg-mem), with prod's ACTUAL licenses columns.
//   node --test src/lib/stripe-webhook.test.js
const test = require("node:test");
const assert = require("node:assert");
const { newDb } = require("pg-mem");
const W = require("./stripe-webhook");

const PRICE_PRO = "price_PRO", PRICE_STATION = "price_STN";

// Prod-shaped (catalog 2026-10-05): stripe_customer_id + stripe_subscription_id — there is NO stripe_sub_id.
async function freshPool() {
  const pool = new (newDb().adapters.createPg().Pool)();
  await pool.query(`CREATE TABLE licenses (
    id SERIAL PRIMARY KEY, license_key TEXT, email TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL,
    stripe_customer_id TEXT, stripe_subscription_id TEXT, status TEXT DEFAULT 'active',
    expires_at TIMESTAMPTZ, active BOOLEAN DEFAULT true, key_prefix TEXT, key_hash TEXT,
    payment_failed_at TIMESTAMPTZ, card_brand TEXT, card_last4 TEXT, card_exp_month INTEGER, card_exp_year INTEGER)`);   // + initDB's billing columns
  await pool.query(`CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT NOT NULL, license_key_id INTEGER)`);
  return pool;
}
function deps(pool, over = {}) {
  const sent = [];
  return {
    sent,
    d: {
      pool, validPlans: new Set(["free", "pro", "pro_lifetime", "station", "station_lifetime", "operator"]),
      planByPriceId: { [PRICE_PRO]: "pro", [PRICE_STATION]: "station" },
      generateLicenseKey: (plan) => `ETH-${plan === "station" ? "STN" : "PRO"}-AAAA-BBBB-CCCC`,
      hashKey: async (k) => `hash:${k}`,
      sendLicenseEmail: async (email, key, plan) => { sent.push({ email, key, plan }); },
      log: { log() {}, warn() {}, error() {} },
      ...over,
    },
  };
}
const ev = (type, object) => ({ type, data: { object } });
const lic = async (pool) => (await pool.query(`SELECT id, plan, active, email, stripe_subscription_id AS sub, stripe_customer_id AS cus FROM licenses ORDER BY id`)).rows;

// ── B1: real columns ──────────────────────────────────────────────────────────────────────────────────

test("B1 branch A: account checkout creates the license on stripe_subscription_id/customer and links the user", async () => {
  const pool = await freshPool();
  await pool.query(`INSERT INTO users (email) VALUES ('a@x.com')`);
  const { d } = deps(pool);
  const out = await W.handlePlatformEvent(ev("checkout.session.completed", {
    client_reference_id: "1", customer_email: "A@x.com", metadata: { plan: "station" }, subscription: "sub_1", customer: "cus_1",
  }), d);
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(await lic(pool), [{ id: 1, plan: "station", active: true, email: "a@x.com", sub: "sub_1", cus: "cus_1" }]);
  assert.strictEqual((await pool.query(`SELECT license_key_id FROM users WHERE id = 1`)).rows[0].license_key_id, 1);
});

test("B1 branch A: a repeat checkout for the same subscription updates, never duplicates", async () => {
  const pool = await freshPool();
  await pool.query(`INSERT INTO users (email) VALUES ('a@x.com')`);
  await pool.query(`INSERT INTO licenses (email, plan, stripe_subscription_id, active) VALUES ('a@x.com','pro','sub_1',false)`);
  const { d } = deps(pool);
  await W.handlePlatformEvent(ev("checkout.session.completed", {
    client_reference_id: "1", customer_email: "a@x.com", metadata: { plan: "station" }, subscription: "sub_1",
  }), d);
  const rows = await lic(pool);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].plan, "station");
  assert.strictEqual(rows[0].active, true);
});

test("B1 branch B: invoice.payment_succeeded issues a license keyed on the invoice's subscription and emails the key", async () => {
  const pool = await freshPool();
  const { d, sent } = deps(pool);
  const out = await W.handlePlatformEvent(ev("invoice.payment_succeeded", {
    object: "invoice", id: "in_1", customer_email: "b@x.com", subscription: "sub_2", customer: "cus_2",
    lines: { data: [{ price: { id: PRICE_PRO } }] },
  }), d);
  assert.strictEqual(out.status, 200);
  const rows = await lic(pool);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].sub, "sub_2", "subscription id, not the invoice id");
  assert.strictEqual(rows[0].plan, "pro");
  assert.strictEqual(sent.length, 1);
});

test("B1 branch B: newer invoice shape (parent.subscription_details + pricing.price_details) is understood", async () => {
  const pool = await freshPool();
  const { d } = deps(pool);
  await W.handlePlatformEvent(ev("invoice.payment_succeeded", {
    object: "invoice", id: "in_9", customer_email: "c@x.com",
    parent: { subscription_details: { subscription: "sub_9" } },
    lines: { data: [{ pricing: { price_details: { price: PRICE_STATION } } }] },
  }), d);
  const rows = await lic(pool);
  assert.strictEqual(rows[0].sub, "sub_9");
  assert.strictEqual(rows[0].plan, "station");
});

test("B1 branch B: renewal of a known subscription reactivates, sends no second key", async () => {
  const pool = await freshPool();
  await pool.query(`INSERT INTO licenses (email, plan, stripe_subscription_id, active) VALUES ('b@x.com','pro','sub_2',false)`);
  const { d, sent } = deps(pool);
  await W.handlePlatformEvent(ev("invoice.payment_succeeded", {
    object: "invoice", id: "in_2", customer_email: "b@x.com", subscription: "sub_2", lines: { data: [{ price: { id: PRICE_PRO } }] },
  }), d);
  assert.strictEqual((await lic(pool))[0].active, true);
  assert.strictEqual(sent.length, 0);
});

// pg-mem's pg-adapter client does NOT honour ROLLBACK (probed: BEGIN/INSERT/ROLLBACK leaves the row; Postgres leaves
// none). So this asserts the transaction PROTOCOL the handler issues on its client — BEGIN, INSERT, ROLLBACK, never
// COMMIT, client released — and the 500. Postgres guarantees what ROLLBACK does with that.
test("B1 branch B: email failure issues ROLLBACK (never COMMIT), releases the client, returns 500 so Stripe retries", async () => {
  const pool = await freshPool();
  const issued = [];
  let released = false;
  const recordingPool = {
    query: (...a) => pool.query(...a),
    connect: async () => {
      const c = await pool.connect();
      return {
        query: (sql, p) => { issued.push(String(sql).trim().split(/\s+/)[0].toUpperCase()); return c.query(sql, p); },
        release: () => { released = true; c.release(); },
      };
    },
  };
  const { d } = deps(recordingPool, { sendLicenseEmail: async () => { throw new Error("resend down"); } });
  const out = await W.handlePlatformEvent(ev("invoice.payment_succeeded", {
    object: "invoice", id: "in_3", customer_email: "e@x.com", subscription: "sub_3", lines: { data: [{ price: { id: PRICE_PRO } }] },
  }), d);
  assert.strictEqual(out.status, 500);
  assert.deepStrictEqual(issued, ["BEGIN", "INSERT", "ROLLBACK"]);
  assert.ok(released, "client released");
});

test("B1 branch B: on success the issue runs BEGIN, INSERT, COMMIT", async () => {
  const pool = await freshPool();
  const issued = [];
  const recordingPool = {
    query: (...a) => pool.query(...a),
    connect: async () => { const c = await pool.connect(); return { query: (s, p) => { issued.push(String(s).trim().split(/\s+/)[0].toUpperCase()); return c.query(s, p); }, release: () => c.release() }; },
  };
  const { d } = deps(recordingPool);
  await W.handlePlatformEvent(ev("invoice.payment_succeeded", {
    object: "invoice", id: "in_13", customer_email: "f@x.com", subscription: "sub_13", lines: { data: [{ price: { id: PRICE_PRO } }] },
  }), d);
  assert.deepStrictEqual(issued, ["BEGIN", "INSERT", "COMMIT"]);
});

test("B1 branch B: unknown price is acknowledged and issues nothing", async () => {
  const pool = await freshPool();
  const { d } = deps(pool);
  const out = await W.handlePlatformEvent(ev("invoice.payment_succeeded", {
    object: "invoice", id: "in_4", customer_email: "u@x.com", subscription: "sub_4", lines: { data: [{ price: { id: "price_NOPE" } }] },
  }), d);
  assert.strictEqual(out.status, 200);
  assert.strictEqual((await lic(pool)).length, 0);
});

// ── B2: failed payment ────────────────────────────────────────────────────────────────────────────────

test("B2: invoice.payment_failed resolves the SUBSCRIPTION (not the invoice id) and keeps access during grace", async () => {
  const pool = await freshPool();
  await pool.query(`INSERT INTO licenses (email, plan, stripe_subscription_id, active) VALUES ('p@x.com','station','sub_5',true)`);
  const { d } = deps(pool);
  for (const invoice of [
    { object: "invoice", id: "in_5", subscription: "sub_5" },
    { object: "invoice", id: "in_5", subscription: { id: "sub_5" } },
    { object: "invoice", id: "in_5", parent: { subscription_details: { subscription: "sub_5" } } },
  ]) {
    const out = await W.handlePlatformEvent(ev("invoice.payment_failed", invoice), d);
    assert.strictEqual(out.body.subscription, "sub_5");
    assert.strictEqual(out.body.grace, true);
  }
  assert.strictEqual((await lic(pool))[0].active, true, "a failed payment never revokes on its own");
});

test("B2: subscriptionIdOf never returns an invoice's own id", () => {
  assert.strictEqual(W.subscriptionIdOf({ object: "invoice", id: "in_7" }), null);
  assert.strictEqual(W.subscriptionIdOf({ object: "subscription", id: "sub_7" }), "sub_7");
});

// ── B3: subscription.updated ──────────────────────────────────────────────────────────────────────────

test("B3: a portal plan change (pro → station) reaches licenses.plan", async () => {
  const pool = await freshPool();
  await pool.query(`INSERT INTO licenses (email, plan, stripe_subscription_id) VALUES ('q@x.com','pro','sub_6')`);
  const { d } = deps(pool);
  await W.handlePlatformEvent(ev("customer.subscription.updated", {
    object: "subscription", id: "sub_6", status: "active", items: { data: [{ price: { id: PRICE_STATION } }] },
  }), d);
  const r = (await lic(pool))[0];
  assert.strictEqual(r.plan, "station");
  assert.strictEqual(r.active, true);
});

test("B3: status mapping — unpaid/canceled revoke, past_due keeps (grace), active restores", async () => {
  const pool = await freshPool();
  await pool.query(`INSERT INTO licenses (email, plan, stripe_subscription_id) VALUES ('s@x.com','station','sub_8')`);
  const { d } = deps(pool);
  const set = (status) => W.handlePlatformEvent(ev("customer.subscription.updated", {
    object: "subscription", id: "sub_8", status, items: { data: [{ price: { id: PRICE_STATION } }] } }), d);
  await set("past_due");  assert.strictEqual((await lic(pool))[0].active, true);
  await set("unpaid");    assert.strictEqual((await lic(pool))[0].active, false);
  await set("active");    assert.strictEqual((await lic(pool))[0].active, true);
  await set("canceled");  assert.strictEqual((await lic(pool))[0].active, false);
});

test("B3: unknown price on update leaves the plan alone", async () => {
  const pool = await freshPool();
  await pool.query(`INSERT INTO licenses (email, plan, stripe_subscription_id) VALUES ('t@x.com','pro','sub_10')`);
  const { d } = deps(pool);
  await W.handlePlatformEvent(ev("customer.subscription.updated", {
    object: "subscription", id: "sub_10", status: "active", items: { data: [{ price: { id: "price_NOPE" } }] } }), d);
  assert.strictEqual((await lic(pool))[0].plan, "pro");
});

test("cancellation: customer.subscription.deleted deactivates only that subscription's license", async () => {
  const pool = await freshPool();
  await pool.query(`INSERT INTO licenses (email, plan, stripe_subscription_id) VALUES ('x@x.com','pro','sub_11'), ('y@x.com','pro','sub_12')`);
  const { d } = deps(pool);
  const out = await W.handlePlatformEvent(ev("customer.subscription.deleted", { object: "subscription", id: "sub_11" }), d);
  assert.strictEqual(out.body.deactivated, 1);
  assert.deepStrictEqual((await lic(pool)).map(r => r.active), [false, true]);
});

test("wired: index.js has no phantom stripe_sub_id in SQL and routes the webhook through the module", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "index.js"), "utf8");
  const sql = src.split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");   // ignore comment lines
  assert.ok(!/stripe_sub_id/.test(sql), "no stripe_sub_id outside comments");
  assert.ok(/stripeWebhook\.handlePlatformEvent\(event/.test(src), "webhook uses the module");
  assert.ok(/manageable: !!lic\.stripe_subscription_id/.test(src), "billing reads the real column");
  assert.ok(/SELECT stripe_subscription_id, stripe_customer_id FROM licenses/.test(src), "portal reads the real columns");
  assert.ok(/if \(event\.account\) \{/.test(src), "connected-account guard still precedes the handler");
});

// ── Billing state: payment_failed_at and the card on file (billing notices) ─────────────────────────────────────────

const billing = async (pool) => (await pool.query(
  `SELECT payment_failed_at AS failed, card_brand AS brand, card_last4 AS last4, card_exp_month AS m, card_exp_year AS y, active FROM licenses ORDER BY id`)).rows;
function fakeStripe({ defaultPm = null, list = [], fail = false } = {}) {
  const calls = [];
  return {
    calls,
    customers: { retrieve: async (id, opts) => { calls.push(["customers.retrieve", id, opts]); if (fail) throw new Error("boom"); return { id, invoice_settings: { default_payment_method: defaultPm } }; } },
    paymentMethods: {
      retrieve: async (id) => { calls.push(["paymentMethods.retrieve", id]); return { id, card: { brand: "mastercard", last4: "4444", exp_month: 3, exp_year: 2028 } }; },
      list: async (q) => { calls.push(["paymentMethods.list", q]); return { data: list }; },
    },
  };
}
const pmCard = (brand, last4, m, y) => ({ object: "payment_method", id: "pm_1", customer: "cus_20", card: { brand, last4, exp_month: m, exp_year: y } });

test("billing: invoice.payment_failed sets payment_failed_at (the first failure is kept), access unchanged", async () => {
  const pool = await freshPool();
  await pool.query(`INSERT INTO licenses (email, plan, stripe_subscription_id, stripe_customer_id) VALUES ('a@x.com','station','sub_20','cus_20')`);
  const { d } = deps(pool);
  await W.handlePlatformEvent({ ...ev("invoice.payment_failed", { object: "invoice", id: "in_1", subscription: "sub_20", customer: "cus_20" }), created: 1793000000 }, d);
  let r = (await billing(pool))[0];
  assert.strictEqual(new Date(r.failed).getTime(), 1793000000 * 1000);
  assert.strictEqual(r.active, true);
  await W.handlePlatformEvent({ ...ev("invoice.payment_failed", { object: "invoice", id: "in_2", subscription: "sub_20" }), created: 1793500000 }, d);
  r = (await billing(pool))[0];
  assert.strictEqual(new Date(r.failed).getTime(), 1793000000 * 1000, "kept, not moved");
});

test("billing: invoice.payment_succeeded clears payment_failed_at", async () => {
  const pool = await freshPool();
  await pool.query(`INSERT INTO licenses (email, plan, stripe_subscription_id, payment_failed_at) VALUES ('b@x.com','station','sub_21', NOW())`);
  const { d } = deps(pool);
  await W.handlePlatformEvent(ev("invoice.payment_succeeded", {
    object: "invoice", customer_email: "b@x.com", subscription: "sub_21", lines: { data: [{ price: { id: PRICE_STATION } }] } }), d);
  assert.strictEqual((await billing(pool))[0].failed, null);
});

test("billing: subscription.updated past_due sets it (if unset), active clears it", async () => {
  const pool = await freshPool();
  await pool.query(`INSERT INTO licenses (email, plan, stripe_subscription_id) VALUES ('c@x.com','station','sub_22')`);
  const { d } = deps(pool);
  const set = (status) => W.handlePlatformEvent(ev("customer.subscription.updated", {
    object: "subscription", id: "sub_22", status, items: { data: [{ price: { id: PRICE_STATION } }] } }), d);
  await set("past_due"); const first = (await billing(pool))[0].failed; assert.ok(first);
  await set("past_due"); assert.strictEqual(new Date((await billing(pool))[0].failed).getTime(), new Date(first).getTime());
  assert.strictEqual((await billing(pool))[0].active, true, "past_due keeps access");
  await set("active");   assert.strictEqual((await billing(pool))[0].failed, null);
});

test("billing: the card on file is recorded from the customer's default payment method", async () => {
  const pool = await freshPool();
  await pool.query(`INSERT INTO licenses (email, plan, stripe_subscription_id, stripe_customer_id) VALUES ('d@x.com','station','sub_23','cus_20')`);
  const stripe = fakeStripe({ defaultPm: { id: "pm_d", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2027 } } });
  const { d } = deps(pool, { stripe });
  await W.handlePlatformEvent(ev("customer.updated", { object: "customer", id: "cus_20" }), d);
  assert.deepStrictEqual((await billing(pool))[0], { failed: null, brand: "visa", last4: "4242", m: 12, y: 2027, active: true });
  assert.deepStrictEqual(stripe.calls[0], ["customers.retrieve", "cus_20", { expand: ["invoice_settings.default_payment_method"] }]);
});

test("billing: a default given as an id is fetched; none → the attached card; none → the first saved card", async () => {
  const pool = await freshPool();
  await pool.query(`INSERT INTO licenses (email, plan, stripe_customer_id) VALUES ('e@x.com','station','cus_20')`);
  let { d } = deps(pool, { stripe: fakeStripe({ defaultPm: "pm_str" }) });
  await W.handlePlatformEvent(ev("customer.updated", { object: "customer", id: "cus_20" }), d);
  assert.strictEqual((await billing(pool))[0].last4, "4444");
  ({ d } = deps(pool, { stripe: fakeStripe() }));
  await W.handlePlatformEvent(ev("payment_method.attached", pmCard("amex", "0005", 1, 2029)), d);
  assert.strictEqual((await billing(pool))[0].last4, "0005");
  ({ d } = deps(pool, { stripe: fakeStripe({ list: [{ card: { brand: "visa", last4: "1881", exp_month: 6, exp_year: 2030 } }] }) }));
  await W.handlePlatformEvent(ev("customer.updated", { object: "customer", id: "cus_20" }), d);
  assert.strictEqual((await billing(pool))[0].last4, "1881");
});

test("billing: card reading is guarded — a Stripe error or a hang never fails the webhook; no Stripe client → nothing read", async () => {
  const pool = await freshPool();
  await pool.query(`INSERT INTO licenses (email, plan, stripe_customer_id) VALUES ('f@x.com','station','cus_20')`);
  const out = await W.handlePlatformEvent(ev("customer.updated", { object: "customer", id: "cus_20" }), deps(pool, { stripe: fakeStripe({ fail: true }) }).d);
  assert.strictEqual(out.status, 200);
  assert.strictEqual((await billing(pool))[0].last4, null);
  const slow = { customers: { retrieve: () => new Promise(() => {}) } };
  const out2 = await W.handlePlatformEvent(ev("customer.updated", { object: "customer", id: "cus_20" }), deps(pool, { stripe: slow, cardTimeoutMs: 20 }).d);
  assert.strictEqual(out2.status, 200);
  const out3 = await W.handlePlatformEvent(ev("customer.updated", { object: "customer", id: "cus_20" }), deps(pool).d);
  assert.strictEqual(out3.status, 200);
});

test("billing: checkout completed records the card for the new license", async () => {
  const pool = await freshPool();
  await pool.query(`INSERT INTO users (email) VALUES ('g@x.com')`);
  const stripe = fakeStripe({ list: [{ card: { brand: "visa", last4: "4242", exp_month: 9, exp_year: 2031 } }] });
  const { d } = deps(pool, { stripe });
  await W.handlePlatformEvent(ev("checkout.session.completed", {
    client_reference_id: "1", customer_email: "g@x.com", metadata: { plan: "station" }, subscription: "sub_30", customer: "cus_30" }), d);
  assert.strictEqual((await billing(pool))[0].last4, "4242");
});

test("wired: the webhook route hands the Stripe client to the module only when a key is set", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "index.js"), "utf8");
  assert.ok(/stripe: process\.env\.STRIPE_SECRET_KEY \? stripe : null/.test(src));
});
