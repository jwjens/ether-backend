'use strict';
// The one billing notice (src/lib/billing-notice.js): every kind, the priority between them, exempt → null.
//   node --test src/lib/billing-notice.test.js
const test = require("node:test");
const assert = require("node:assert");
const { billingNotice, portalReturnUrl, cardExpiryEnd } = require("./billing-notice");
const catalog = require("./plans").load();

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 31, 12);   // 2026-10-31 12:00 UTC
const at = (days) => new Date(NOW + days * DAY).toISOString();
const N = (license, extra = {}) => billingNotice({ license, catalog, now: NOW, exemptIds: new Set([99]), accountUrl: "https://acct.test", ...extra });
const trial = (days, over = {}) => ({ id: 1, plan: "station", active: true, expires_at: at(days), ...over });
const paid = (over = {}) => ({ id: 2, plan: "station", active: true, expires_at: null, stripe_subscription_id: "sub_1", stripe_customer_id: "cus_1", ...over });

test("trial_ending: 3 days or fewer left; not with 4", () => {
  const n = N(trial(2));
  assert.equal(n.kind, "trial_ending");
  assert.equal(n.daysLeft, 2);
  assert.equal(n.severity, "info");
  assert.deepEqual(n.action, { label: "Add a card", url: "https://acct.test/?billing=add-card", portal: false });
  assert.match(n.body, /keeps playing/);
  assert.equal(N(trial(4)), null);
});

test("trial_ended: trial over, within the grace period, says when cloud features stop being included", () => {
  const n = N(trial(-1));
  assert.equal(n.kind, "trial_ended");
  assert.equal(n.endsAt, at(6));
  assert.match(n.body, /November 6, 2026/);
  assert.match(n.body, /keeps playing/);
});

test("grace: a customer's paid period ended, within past_due_days", () => {
  const n = N(paid({ expires_at: at(-2) }));
  assert.equal(n.kind, "grace");
  assert.equal(n.action.label, "Update card");
  assert.equal(n.action.portal, true);
  assert.equal(n.daysLeft, 5);
});

test("lapsed: after the grace period (trial or customer)", () => {
  assert.equal(N(trial(-10)).kind, "lapsed");
  assert.equal(N(trial(-10)).action.label, "Add a card");
  const c = N(paid({ expires_at: at(-10) }));
  assert.equal(c.kind, "lapsed");
  assert.equal(c.severity, "error");
  assert.match(c.body, /keeps playing/);
});

test("payment_failed: within past_due_days names the date; after it still shows, without a date", () => {
  const n = N(paid({ payment_failed_at: at(-1) }));
  assert.equal(n.kind, "payment_failed");
  assert.equal(n.endsAt, at(6));
  assert.match(n.body, /November 6, 2026/);
  const late = N(paid({ payment_failed_at: at(-9) }));
  assert.equal(late.kind, "payment_failed");
  assert.equal(late.endsAt, undefined);
});

test("card_expired / card_expiring from the stored card (good through the end of its month)", () => {
  assert.equal(cardExpiryEnd({ card_exp_month: 12, card_exp_year: 2026 }), Date.UTC(2027, 0, 1));
  const ex = N(paid({ card_brand: "visa", card_last4: "4242", card_exp_month: 9, card_exp_year: 2026 }));
  assert.equal(ex.kind, "card_expired");
  assert.match(ex.body, /Visa ending 4242 expired at the end of September 2026/);
  const soon = N(paid({ card_brand: "visa", card_last4: "4242", card_exp_month: 10, card_exp_year: 2026 }));
  assert.equal(soon.kind, "card_expiring");
  assert.ok(soon.daysLeft <= 30);
  assert.equal(N(paid({ card_exp_month: 1, card_exp_year: 2027 })), null, "more than 30 days away");
});

test("paid and fine: no notice", () => {
  assert.equal(N(paid()), null);
  assert.equal(N(paid({ card_exp_month: 12, card_exp_year: 2030 })), null);
});

test("priority: lapsed > grace > payment_failed > card_expired > trial_ended > trial_ending > card_expiring", () => {
  const exp = { card_exp_month: 9, card_exp_year: 2026 }, soon = { card_exp_month: 10, card_exp_year: 2026 };
  assert.equal(N(paid({ expires_at: at(-10), payment_failed_at: at(-1), ...exp })).kind, "lapsed");
  assert.equal(N(paid({ expires_at: at(-2), payment_failed_at: at(-1), ...exp })).kind, "grace");
  assert.equal(N(paid({ payment_failed_at: at(-1), ...exp })).kind, "payment_failed");
  assert.equal(N(paid({ ...exp })).kind, "card_expired");
  // a trial with a card on file is not a "customer" for the trial notices unless Stripe is attached; card notices need Stripe
  assert.equal(N(trial(-1, { payment_failed_at: at(-1) })).kind, "payment_failed");
  assert.equal(N(trial(-1)).kind, "trial_ended");
  assert.equal(N(trial(1)).kind, "trial_ending");
  assert.equal(N(paid({ ...soon })).kind, "card_expiring");
});

test("exempt → null: lifetime, operator, platform-created (TIER_EXEMPT_LICENSE_IDS) — whatever the dates or card", () => {
  const bad = { expires_at: at(-100), payment_failed_at: at(-1), card_exp_month: 1, card_exp_year: 2020, stripe_customer_id: "cus_x" };
  assert.equal(N({ id: 5, plan: "station_lifetime", active: true, ...bad }), null);
  assert.equal(N({ id: 6, plan: "pro_lifetime", active: true, ...bad }), null);
  assert.equal(N({ id: 7, plan: "operator", active: true, ...bad }), null);
  assert.equal(N({ id: 99, plan: "station", active: true, ...bad }), null);
});

test("switched off, unknown plan, Founding Local (old free key): null", () => {
  assert.equal(N(paid({ active: false, payment_failed_at: at(-1) })), null);
  assert.equal(N({ id: 3, plan: "nonsense", active: true }), null);
  assert.equal(N({ id: 4, plan: "free", active: true, expires_at: at(-30) }), null);
});

test("no license yet: the users row's trial", () => {
  assert.equal(billingNotice({ user: { trial_ends_at: at(1) }, catalog, now: NOW }).kind, "trial_ending");
  assert.equal(billingNotice({ user: { trial_ends_at: at(-2) }, catalog, now: NOW }).kind, "trial_ended");
  assert.equal(billingNotice({ user: { trial_ends_at: at(10) }, catalog, now: NOW }), null);
  assert.equal(billingNotice({ user: {}, catalog, now: NOW }), null);
  assert.equal(billingNotice({ catalog, now: NOW }), null);
});

test("every notice says playout keeps running", () => {
  const all = [N(trial(2)), N(trial(-1)), N(paid({ expires_at: at(-2) })), N(trial(-10)), N(paid({ payment_failed_at: at(-1) })),
    N(paid({ card_exp_month: 9, card_exp_year: 2026 })), N(paid({ card_exp_month: 10, card_exp_year: 2026 }))];
  assert.deepEqual(all.map(n => n.kind).sort(), ["card_expired", "card_expiring", "grace", "lapsed", "payment_failed", "trial_ended", "trial_ending"]);
  for (const n of all) assert.match(n.body, /keeps playing — billing never stops audio or playout/);
});

test("portal return address: our sites only; localhost only when allowed", () => {
  assert.equal(portalReturnUrl("https://app.ether-cast.com"), "https://app.ether-cast.com");
  assert.equal(portalReturnUrl("https://signup.ether-cast.com"), "https://signup.ether-cast.com");
  assert.equal(portalReturnUrl("https://evil.example"), "https://app.ether-cast.com");
  assert.equal(portalReturnUrl("http://localhost:5173"), "https://app.ether-cast.com");
  assert.equal(portalReturnUrl("http://localhost:5173", { allowLocalhost: true }), "http://localhost:5173");
});
