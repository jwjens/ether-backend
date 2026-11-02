'use strict';
// STEP 3d, stage 1 — a Stripe TEST CLOCK customer for test10@ether.test, Live 128 monthly, paid at Stripe test Checkout
// with 4242 4242 4242 4242 expiring 12/26 (so the card-expiring notice can be reached by moving the clock).
// The session is made here with the SAME settings the server's POST /api/user/checkout uses (line items from
// billing-prices.js, client_reference_id, metadata, return pages), except `customer` (the test-clock customer) in place
// of `customer_email` — Stripe only runs a subscription on a test clock when its customer is on that clock.
// State for the next stages: billing-test/d-state.json.
const fs = require("node:fs");
const path = require("node:path");
const L = require("./lib");
const BILLING = require("../src/lib/billing-prices");
const CATALOG = require("../src/lib/plans").load();
const STATE = path.join(__dirname, process.env.BT_STATE || "d-state.json");

(async () => {
  const email = process.env.BT_EMAIL || "test10@ether.test";
  const { s, env } = L.stripe();
  const out = { email };
  const problems = [];
  const br = await L.browser();
  const page = await br.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await L.signup(email, email.split("@")[0]);
    const uid = (await L.db(`SELECT id FROM users WHERE email = '${email}'`))[0].id;
    const start = Math.floor(Date.now() / 1000);
    const clock = await s.testHelpers.testClocks.create({ frozen_time: start, name: `ether billing test 3d (${email})` });
    const customer = await s.customers.create({ email, name: email.split("@")[0], test_clock: clock.id, metadata: { ether_test: "3d" } });
    const c = BILLING.checkoutItems(CATALOG, env, { plan: "station", period: "monthly" });
    if (c.error) throw new Error(`checkoutItems: ${c.error}`);
    const session = await s.checkout.sessions.create({
      mode: "subscription", line_items: c.items, customer: customer.id,
      client_reference_id: String(uid), metadata: { user_id: String(uid), plan: c.plan, period: c.period },
      success_url: `${L.SITE}/?subscribed=1`, cancel_url: `${L.SITE}/`, allow_promotion_codes: true,
    });
    await page.goto(session.url);
    await L.payCheckout(page, "4242424242424242", async () => {
      await L.shot(page, "d-checkout-4242-exp-12-26", `3d · test-clock customer ${email}: Live 128 monthly at Stripe test Checkout, 4242 4242 4242 4242 expiring 12/26`);
    }, { expiry: "12 / 26" });
    await page.waitForURL((u) => u.href.startsWith(`${L.SITE}/?subscribed=1`), { timeout: 60000 });
    const lic = await L.waitFor(async () => {
      const r = await L.db(`SELECT l.id, l.plan, l.active, l.expires_at, l.grace_until, l.payment_failed_at, l.stripe_subscription_id, l.card_last4, l.card_exp_month, l.card_exp_year FROM licenses l JOIN users u ON u.license_key_id = l.id WHERE u.email = '${email}'`);
      return r[0] && r[0].stripe_subscription_id && r[0].card_last4 ? r[0] : null;
    }, 60000);
    if (!lic) throw new Error("no license (with the card on file) was linked to the account");
    const sub = await s.subscriptions.retrieve(lic.stripe_subscription_id);
    await L.siteLogin(page, email);
    await page.waitForTimeout(1200);
    await L.shot(page, "d-account-active", `3d · ${email} after paying: license ${lic.id}, plan ${lic.plan}, active, card ${lic.card_last4} exp ${lic.card_exp_month}/${lic.card_exp_year}; renews ${new Date(sub.current_period_end * 1000 || sub.items.data[0].current_period_end * 1000).toISOString().slice(0, 10)} (test clock ${clock.id})`);
    const state = { email, uid, clock: clock.id, start, customer: customer.id, subscription: sub.id, license_id: lic.id,
      period_end: sub.current_period_end || sub.items.data[0].current_period_end };
    fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
    Object.assign(out, { state, license: lic, subscription_status: sub.status });
    if (lic.plan !== "station" || lic.active !== true) problems.push(`license ${JSON.stringify(lic)}`);
  } catch (e) {
    await L.shot(page, "d1-error", `3d stage 1 — the run stopped here: ${e.message.split("\n")[0]}`).catch(() => {});
    problems.push(`driver error: ${e.message.split("\n")[0]}`);
  }
  out.pass = problems.length === 0; out.problems = problems;
  L.record("d1-subscribe", out);
  console.log(JSON.stringify(out, null, 1));
  await br.close();
})();
