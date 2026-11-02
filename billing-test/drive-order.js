'use strict';
// RERUN — STRIPE EVENT ORDER on the fixed server (backend c39a5fe): an older Stripe message delivered after a newer one
// must not overwrite the newer state. test14@ether.test on its own Stripe TEST clock (state from drive-d1.js):
//   1. 0341 becomes the card; the clock passes the renewal → the payment fails → grace.
//   2. An OLDER "customer.subscription.updated" (status active, from before the failure — fetched from Stripe by id) is
//      delivered late → the grace must stay.
//   3. 4242 back, the open invoice paid → active, grace cleared.
//   4. The OLDER "invoice.payment_failed" is delivered late → no grace must come back.
// Late deliveries are signed with the test webhook secret and sent to the LOCAL webhook only.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const L = require("./lib");
const STATE = path.join(__dirname, process.env.BT_STATE || "d-state.json");

(async () => {
  const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const { s, env } = L.stripe();
  const problems = [];
  const out = { email: st.email, steps: [] };
  const br = await L.browser();
  const page = await br.newPage({ viewport: { width: 1280, height: 900 } });
  const lic = async () => (await L.db(`SELECT id, active, grace_until, payment_failed_at, card_last4 FROM licenses WHERE id = ${st.license_id}`))[0];
  const late = async (ev) => {
    const payload = JSON.stringify(ev);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac("sha256", env.STRIPE_WEBHOOK_SECRET).update(`${t}.${payload}`).digest("hex");
    const r = await fetch(`${L.API}/webhook/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` }, body: payload });
    return { id: ev.id, type: ev.type, created: new Date(ev.created * 1000).toISOString(), message_status: ev.data.object.status || null, answer: r.status };
  };
  const card = async (pmToken) => {
    const pm = await s.paymentMethods.attach(pmToken, { customer: st.customer });
    await s.customers.update(st.customer, { invoice_settings: { default_payment_method: pm.id } });
    await s.subscriptions.update(st.subscription, { default_payment_method: pm.id });
    return pm.card.last4;
  };
  const shot = async (slug, caption) => { await L.siteLogin(page, st.email); await page.waitForTimeout(1200); return L.shot(page, slug, caption); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const before = Math.floor(Date.now() / 1000) - 3600;
    // 1 — the failure
    await card("pm_card_chargeCustomerFail");
    await sleep(8000);
    await s.testHelpers.testClocks.advance(st.clock, { frozen_time: st.period_end + 6 * 3600 });
    await L.waitFor(async () => (await s.testHelpers.testClocks.retrieve(st.clock)).status === "ready", 180000, 2000);
    const l1 = await L.waitFor(async () => { const r = await lic(); return r && r.grace_until ? r : null; }, 60000, 2000);
    out.steps.push({ step: "renewal declined", license: l1 });
    if (!l1) problems.push("1: the declined renewal did not start grace");
    await shot("o1-failed", `ORDER RERUN 1 · ${st.email}: renewal declined on 0341 → grace until ${l1 && new Date(l1.grace_until).toISOString().slice(0, 10)}`);

    // 2 — an older "subscription active" delivered late
    const subEvents = (await s.events.list({ type: "customer.subscription.updated", created: { gte: before }, limit: 100 })).data
      .filter((e) => e.data.object.id === st.subscription && e.data.object.status === "active");
    const stale = subEvents[subEvents.length - 1];   // the oldest active one in this window
    if (!stale) throw new Error("no older 'subscription active' event found for the subscription");
    const a2 = await late(stale);
    await sleep(3000);
    const l2 = await lic();
    out.steps.push({ step: "older 'subscription active' delivered late", delivered: a2, license: l2 });
    if (!l2.grace_until) problems.push("2: the older 'subscription active' cleared the grace");
    await shot("o2-stale-active", `ORDER RERUN 2 · an OLDER "subscription active" (${a2.created}) delivered after the failure, answered ${a2.answer} → grace kept (until ${l2.grace_until ? new Date(l2.grace_until).toISOString().slice(0, 10) : "— CLEARED"}); Stripe says past_due now`);

    // 3 — paid again
    await card("pm_card_visa");
    const subNow = await s.subscriptions.retrieve(st.subscription);
    const failedInvoice = typeof subNow.latest_invoice === "string" ? subNow.latest_invoice : subNow.latest_invoice.id;
    await s.invoices.pay(failedInvoice);
    const l3 = await L.waitFor(async () => { const r = await lic(); return r && !r.grace_until ? r : null; }, 60000, 2000);
    out.steps.push({ step: "paid again", license: l3 });
    if (!l3) problems.push("3: paying again did not clear the grace");
    await shot("o3-paid", `ORDER RERUN 3 · card 4242, the open invoice paid → active, grace cleared`);

    // 4 — the older "payment failed" delivered late
    const failEvents = (await s.events.list({ type: "invoice.payment_failed", created: { gte: before }, limit: 100 })).data
      .filter((e) => e.data.object.id === failedInvoice);
    const staleFail = failEvents[failEvents.length - 1];
    if (!staleFail) throw new Error("no older 'payment failed' event found for the invoice");
    const a4 = await late(staleFail);
    await sleep(3000);
    const l4 = await lic();
    out.steps.push({ step: "older 'payment failed' delivered late", delivered: a4, license: l4 });
    if (l4.grace_until || l4.payment_failed_at) problems.push("4: the older 'payment failed' brought the grace back");
    await shot("o4-stale-failed", `ORDER RERUN 4 · the OLDER "payment failed" (${a4.created}) delivered after the payment, answered ${a4.answer} → no grace (${l4.grace_until ? "GRACE SET — FAIL" : "none"}); Stripe says active now`);
  } catch (e) {
    await L.shot(page, "o-error", `ORDER RERUN — the run stopped here: ${e.message.split("\n")[0]}`).catch(() => {});
    problems.push(`driver error: ${e.message.split("\n")[0]}`);
  }
  out.pass = problems.length === 0; out.problems = problems;
  L.record("o-event-order", out);
  console.log(JSON.stringify(out, null, 1));
  await br.close();
})();
