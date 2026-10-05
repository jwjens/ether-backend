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
    expires_at TIMESTAMPTZ, active BOOLEAN DEFAULT true, key_prefix TEXT, key_hash TEXT)`);
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
  assert.ok(/SELECT plan, stripe_subscription_id, email FROM licenses/.test(src), "billing reads the real column");
  assert.ok(/SELECT stripe_subscription_id FROM licenses/.test(src), "portal reads the real column");
  assert.ok(/if \(event\.account\) \{/.test(src), "connected-account guard still precedes the handler");
});
