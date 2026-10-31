'use strict';
// Billing notices through the real server (test/server-harness.js: real routes, real boot schema, pg-mem; email
// recorded, never sent; no Stripe key set, so nothing here reaches Stripe).
//   · the desktop reads billing_notice on /account/connect (also on its lapsed-trial refusal)
//   · the dashboard reads notice on GET /api/account/billing
//   · the account site reads account.billing_notice on /api/user/me and login
//   · the portal refuses cleanly without Stripe; the user portal route exists
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { startServer } = require("./server-harness");

const DAY = 86400000;
const at = (d) => new Date(Date.now() + d * DAY).toISOString();
let h;
test.before(async () => {
  h = await startServer();
  const t = (await h.pool.query(`SELECT COUNT(*)::int n FROM seat_tiers WHERE is_default = true`)).rows[0].n;
  if (!t) await h.pool.query(`INSERT INTO seat_tiers (name, seat_limit, is_default) VALUES ('Test default', NULL, true)`);
});
test.after(async () => { if (h) await h.close(); });

let n = 0;
async function account(lic) {
  n++;
  const key = `ETH-STN-BN${n}A-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const email = `bn${n}@billing.test`;
  const cols = { email, license_key: key, key_prefix: key.slice(0, 12), plan: "station", active: true, ...lic };
  const names = Object.keys(cols);
  const id = (await h.pool.query(`INSERT INTO licenses (${names.join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
    names.map(k => cols[k]))).rows[0].id;
  const uid = (await h.pool.query(`INSERT INTO users (email, password_hash, email_verified, license_key_id, unsubscribe_token) VALUES ($1,$2,true,$3,$4) RETURNING id`,
    [email, await bcrypt.hash("password-1", 4), id, crypto.randomBytes(8).toString("hex")])).rows[0].id;
  const owner = jwt.sign({ uid, lk: id, role: "admin", username: email, typ: "owner" }, h.secrets.JWT_SECRET);
  const user = jwt.sign({ uid, typ: "user" }, h.secrets.JWT_SECRET);
  return { id, key, email, uid, owner, user };
}
const connect = (a) => h.call("POST", "/account/connect", { body: { license_key: a.key, machine_id: `m-${a.id}` } });

test("desktop: /account/connect carries billing_notice (trial ending in 2 days)", async () => {
  const a = await account({ expires_at: at(2) });
  const r = await connect(a);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.billing_notice.kind, "trial_ending");
  assert.equal(r.body.billing_notice.action.label, "Add a card");
});

test("desktop: a lapsed trial's refusal still carries the notice (banner, never a block)", async () => {
  const a = await account({ expires_at: at(-1) });
  const r = await connect(a);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, "trial_expired");
  assert.equal(r.body.billing_notice.kind, "trial_ended");
});

test("desktop: paid and fine → billing_notice null; lifetime → null whatever its dates", async () => {
  assert.equal((await connect(await account({ stripe_subscription_id: "sub_ok", stripe_customer_id: "cus_ok" }))).body.billing_notice, null);
  const life = await account({ plan: "station_lifetime", expires_at: null, payment_failed_at: at(-1), stripe_customer_id: "cus_l" });
  assert.equal((await connect(life)).body.billing_notice, null);
});

test("dashboard: GET /api/account/billing → notice + the facts behind the Billing card", async () => {
  const a = await account({ stripe_subscription_id: "sub_pf", stripe_customer_id: "cus_pf", payment_failed_at: at(-1),
                            card_brand: "visa", card_last4: "0341", card_exp_month: 12, card_exp_year: 2030 });
  const r = await h.call("GET", "/api/account/billing", { headers: { authorization: `Bearer ${a.owner}` } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.notice.kind, "payment_failed");
  assert.equal(r.body.notice.action.portal, true);
  assert.deepEqual(r.body.card, { brand: "visa", last4: "0341", exp_month: 12, exp_year: 2030 });
  assert.ok(r.body.payment_failed_at);
  assert.equal(r.body.entitlement_status, "active");
});

test("account site: /api/user/me and login carry billing_notice and billing_customer", async () => {
  const a = await account({ stripe_subscription_id: "sub_ce", stripe_customer_id: "cus_ce", card_brand: "visa", card_last4: "0069", card_exp_month: 1, card_exp_year: 2020 });
  const me = await h.call("GET", "/api/user/me", { headers: { authorization: `Bearer ${a.user}` } });
  assert.equal(me.status, 200, me.text);
  assert.equal(me.body.account.billing_notice.kind, "card_expired");
  assert.equal(me.body.account.billing_customer, true);
  const li = await h.call("POST", "/api/user/login", { body: { email: a.email, password: "password-1" } });
  assert.equal(li.status, 200, li.text);
  assert.equal(li.body.account.billing_notice.kind, "card_expired");
});

test("account site: no license yet → the users row's trial", async () => {
  const s = await h.call("POST", "/api/user/signup", { body: { email: "fresh@billing.test", password: "password-1" } });
  assert.equal(s.status, 200, s.text);
  await h.pool.query(`UPDATE users SET trial_ends_at = $1 WHERE email = 'fresh@billing.test'`, [at(1)]);
  const me = await h.call("GET", "/api/user/me", { headers: { authorization: `Bearer ${s.body.token}` } });
  assert.equal(me.body.account.billing_notice.kind, "trial_ending");
  assert.equal(me.body.account.billing_customer, false);
});

test("portals: without a Stripe key both answer 503 stripe_unconfigured (nothing reaches Stripe)", async () => {
  assert.ok(!process.env.STRIPE_SECRET_KEY, "the test runs with no Stripe key");
  const a = await account({ stripe_subscription_id: "sub_p", stripe_customer_id: "cus_p" });
  const d = await h.call("POST", "/api/account/billing/portal", { headers: { authorization: `Bearer ${a.owner}` } });
  assert.equal(d.status, 503);
  const u = await h.call("POST", "/api/user/billing/portal", { headers: { authorization: `Bearer ${a.user}` } });
  assert.equal(u.status, 503);
  assert.equal((await h.call("POST", "/api/user/billing/portal")).status, 401);
});

test("wired: the portal's return address allowlist includes app.ether-cast.com", () => {
  const { portalReturnUrl } = require("../src/lib/billing-notice");
  assert.equal(portalReturnUrl("https://app.ether-cast.com"), "https://app.ether-cast.com");
  const src = require("node:fs").readFileSync(require.resolve("../src/index.js"), "utf8");
  assert.match(src, /BILLING_NOTICE\.portalReturnUrl\(origin/);
});
