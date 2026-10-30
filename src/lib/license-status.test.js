'use strict';
const test = require("node:test");
const assert = require("node:assert/strict");
const plans = require("./plans");
const { licenseStatus, tierChoiceOf, tierOptions, TIER_WRITES } = require("./license-status");

const catalog = plans.load();
const now = Date.parse("2026-10-29T12:00:00Z");
const day = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const st = (lic, opts = {}) => licenseStatus({ id: 1, active: true, ...lic }, { catalog, now, exemptIds: new Set(), ...opts });

test("a station key with a future expires_at is a trial, with days left and its end date", () => {
  const s = st({ plan: "station", expires_at: iso(now + 4 * day + 3600000) });
  assert.equal(s.status, "trial");
  assert.equal(s.days_left, 5);
  assert.equal(s.label, "Trial · 5 days left");
  assert.equal(s.date_kind, "trial_ends");
  assert.equal(s.date, iso(now + 4 * day + 3600000));
  assert.equal(s.paid_through, null);
});

test("past the end: grace for the catalog's grace days, then lapsed", () => {
  assert.equal(st({ plan: "station", expires_at: iso(now - 2 * day) }).status, "grace");
  const l = st({ plan: "station", expires_at: iso(now - (catalog.grace.past_due_days + 1) * day) });
  assert.equal(l.status, "lapsed");
  assert.equal(l.date_kind, "expires");
});

test("lifetime and operator keys are Lifetime, even with a stale expires_at", () => {
  for (const plan of ["station_lifetime", "pro_lifetime", "operator"]) {
    const s = st({ plan, expires_at: iso(now - 100 * day) });
    assert.equal(s.status, "lifetime", plan);
    assert.equal(s.date, null, plan);
    assert.equal(s.tier_choice, "lifetime", plan);
  }
});

test("a key with no expiry is Paid; Stripe shows it and its next charge", () => {
  const sub = { status: "active", current_period_end: Math.floor((now + 20 * day) / 1000), cancel_at_period_end: false };
  const s = st({ plan: "station", expires_at: null, stripe_subscription_id: "sub_x" }, { sub });
  assert.equal(s.status, "paid");
  assert.equal(s.paid_through, "stripe");
  assert.equal(s.date_kind, "renews");
  assert.equal(s.next_charge, new Date(sub.current_period_end * 1000).toISOString());
  const c = st({ plan: "station", stripe_subscription_id: "sub_x" }, { sub: { ...sub, cancel_at_period_end: true } });
  assert.equal(c.date_kind, "expires");
  assert.equal(c.next_charge, null);
  const n = st({ plan: "station" });
  assert.equal(n.paid_through, null);
  assert.equal(n.date, null);
});

test("Stripe not answering leaves the subscription shown without a date", () => {
  const s = st({ plan: "pro", stripe_subscription_id: "sub_x" }, { sub: null });
  assert.equal(s.paid_through, "stripe");
  assert.equal(s.next_charge, null);
});

test("off and unknown keys say so", () => {
  assert.equal(st({ plan: "station", active: false }).status, "off");
  assert.equal(st({ plan: "mystery" }).status, "unknown");
});

test("the old free key reads \"Free (old key)\" (never Paid), Local in the dropdown", () => {
  const s = st({ plan: "free", expires_at: iso(now - 100 * day) });
  assert.equal(s.status, "free_old");
  assert.equal(s.label, "Free (old key)");
  assert.equal(s.tier_choice, "local");
});

test("the dropdown: the catalog's plans plus Lifetime; every choice writes a key the server accepts", () => {
  const VALID = new Set(["free", "pro", "pro_lifetime", "station", "station_lifetime", "operator", "unlimited"]);
  const opts = tierOptions(catalog);
  assert.deepEqual(opts.map(o => o.label), ["Local", "Station", "Pro", "Unlimited", "Lifetime"]);
  for (const o of opts) assert.ok(VALID.has(o.writes), o.key);
  assert.equal(TIER_WRITES.unlimited, "unlimited", "Unlimited is its own key, never operator");
  // every old key shows as a choice, and re-choosing it writes nothing new for the keys that map one to one
  assert.equal(tierChoiceOf("station"), "station");
  assert.equal(tierChoiceOf("pro"), "pro");
  assert.equal(tierChoiceOf("free"), "local");
});

test("unlimited renews and expires like the other paid plans; it is never Lifetime", () => {
  assert.equal(tierChoiceOf("unlimited"), "unlimited");
  assert.equal(st({ plan: "unlimited" }).status, "paid");
  const t = st({ plan: "unlimited", expires_at: iso(now + 3 * day) });
  assert.equal(t.status, "trial");
  assert.equal(st({ plan: "unlimited", expires_at: iso(now - 2 * day) }).status, "grace");
  assert.equal(st({ plan: "unlimited", expires_at: iso(now - 60 * day) }).status, "lapsed");
});
