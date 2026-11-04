'use strict';
// The plan catalog (config/plans.json) and what a license may use (entitlements.js).
// docs/paywall-entitlements-plan.md (desktop repo), Rulings 2026-10-29.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const P = require("./plans");
const { entitlementsFor, allows } = require("./entitlements");

const catalog = P.load();
const NOW = Date.parse("2026-10-29T12:00:00Z");
const DAY = 86400000;
const ent = (lic, opts = {}) => entitlementsFor(lic, { catalog, now: NOW, exemptIds: new Set(), ...opts });
const at = (ms) => new Date(ms).toISOString();

test("catalog: the 2026-10-31 prices — no free plan; Local $20/mo or $200/yr; Live $25 / $49; Network $79 for 5 stations", () => {
  assert.deepEqual(Object.keys(catalog.plans), ["local", "station", "pro", "unlimited"]);
  assert.equal(catalog.plans.local.price_monthly, 20); assert.equal(catalog.plans.local.price_annual, 200);
  assert.equal(catalog.plans.local.per, "account", "Local is one price for everything local on the account (Jeff, 2026-10-29)");
  assert.equal(catalog.plans.station.label, "Live 128"); assert.equal(catalog.plans.station.price_monthly, 25);
  assert.equal(catalog.plans.station.max_bitrate_kbps, 128); assert.equal(catalog.plans.station.listeners_per_stream, 50);
  assert.equal(catalog.plans.pro.label, "Live 320"); assert.equal(catalog.plans.pro.price_monthly, 49);
  assert.equal(catalog.plans.pro.max_bitrate_kbps, 320); assert.equal(catalog.plans.pro.listeners_per_stream, 150);
  assert.ok(catalog.plans.pro.priority_support);
  const n = catalog.plans.unlimited;
  assert.equal(n.label, "Network"); assert.equal(n.price_monthly, 79); assert.equal(n.stations_included, 5);
  assert.equal(n.max_bitrate_kbps, 128, "Network: 128 kbps per station (Jeff, 2026-11-01)");
  assert.equal(n.listener_pool, 250, "250 listeners shared across the account's stations");
  assert.deepEqual(n.extra_station, { price_monthly: 15, listeners: 50 }, "each extra $15 station adds 50 to the pool");
  for (const [k, p] of Object.entries(catalog.plans)) assert.equal(p.price_annual, p.price_monthly * 10, `${k}: annual = 10 months`);
  assert.equal(catalog.addons.listeners_50.price_monthly, 10);
  assert.equal(catalog.discounts.multi_station, undefined, "the 3+ station discount is gone (Jeff, 2026-10-31)");
  assert.equal(catalog.trial.days, 15); assert.equal(catalog.trial.requires_card, false);
  assert.deepEqual(catalog.grace, { past_due_days: 7, suspended_days: 30, retention_days: 90 });
  for (const p of Object.values(catalog.plans)) assert.ok(p.price_monthly > 0, `a plan costs nothing: ${p.label}`);
});

test("catalog: an annual price that is not 10 months, or a broken extra station, refuses to load", () => {
  const a = JSON.parse(JSON.stringify(catalog)); a.plans.pro.price_annual = 480;
  assert.ok(P.validate(a).some(e => /plans\.pro\.price_annual/.test(e)));
  const b = JSON.parse(JSON.stringify(catalog)); b.plans.unlimited.extra_station = { price_monthly: "15" };
  assert.ok(P.validate(b).some(e => /extra_station/.test(e)));
  const c = JSON.parse(JSON.stringify(catalog)); delete c.lifetime_limits;
  assert.ok(P.validate(c).some(e => /lifetime_limits/.test(e)));
});

test("catalog: Local has no cloud; the Remote Link relay is Station and up", () => {
  assert.equal(catalog.plans.local.cloud, false);
  assert.deepEqual(catalog.features.link_relay.plans, ["station", "pro", "unlimited"]);
  for (const [f, d] of Object.entries(catalog.features))
    // iris: Jeff, 2026-11-04 — "Includes Iris" on every plan, including Local (desktop docs/iris-stage1-plan-2026-11-04.md).
    if (!["public_page", "now_playing", "iris"].includes(f)) assert.ok(!d.plans.includes("local"), `Local carries cloud feature ${f}`);
});

test("catalog: validation refuses a bad catalog (the server would not boot on it)", () => {
  const bad = JSON.parse(JSON.stringify(catalog));
  bad.plans.free = { label: "Free", price_monthly: 0, cloud: false };
  assert.ok(P.validate(bad).some(e => /free/.test(e)));
  const bad2 = JSON.parse(JSON.stringify(catalog)); delete bad2.plans.local.price_monthly;
  assert.ok(P.validate(bad2).length);
  const bad3 = JSON.parse(JSON.stringify(catalog)); bad3.plans.local.per = "seat";
  assert.ok(P.validate(bad3).some(e => /plans\.local\.per/.test(e)), "a price must say what it covers: account, station or stream");
});

test("catalog: /public/plans says which prices can be bought, never the Stripe ids or variable names", () => {
  const pub = P.publicCatalog(catalog, { PRICE_LOCAL_MONTHLY: "price_secretish_123" });
  const s = JSON.stringify(pub);
  assert.ok(!s.includes("price_secretish_123")); assert.ok(!s.includes("PRICE_LOCAL_MONTHLY"));
  assert.equal(pub.purchasable.local_monthly, true); assert.equal(pub.purchasable.local_annual, false);
  assert.deepEqual(P.priceIndex(catalog, { PRICE_LOCAL_MONTHLY: "price_x" }), { price_x: { key: "local", period: "monthly" } });
});

test("no price is typed into server code: every one lives in config/plans.json", () => {
  const src = ["entitlements.js", "plans.js"].map(f => fs.readFileSync(path.join(__dirname, f), "utf8")).join("\n");
  assert.ok(!/\$\s?\d|price_monthly\s*[:=]\s*\d/.test(src));
});

test("a new trial: full access (Unlimited-level, cloud on) until it ends", () => {
  const e = ent({ id: 1, plan: "station", active: true, expires_at: at(NOW + 10 * DAY) });
  assert.equal(e.status, "trial"); assert.equal(e.cloud, true); assert.equal(e.level, "unlimited");
  assert.ok(allows(e, "sync") && allows(e, "link_relay") && allows(e, "cloud_backup"));
});

test("LAPSE RULE: a trial that ended keeps cloud for the 7-day grace, then cloud stops — and that is all it does", () => {
  const lic = { id: 1, plan: "station", active: true, expires_at: at(NOW - 2 * DAY) };
  const g = ent(lic);
  assert.equal(g.status, "grace"); assert.equal(g.cloud, true);
  assert.equal(g.grace_until, at(NOW + 5 * DAY));
  const l = ent({ ...lic, expires_at: at(NOW - 8 * DAY) });
  assert.equal(l.status, "lapsed"); assert.equal(l.cloud, false);
  assert.ok(!allows(l, "sync"));
  // the entitlement says nothing about audio, playout, scheduling, logging or startup: there is no such field to read
  const local = /(^|_)(audio|playout|schedul\w*|logs?|logging|startup|on_air)($|_)/;
  for (const k of Object.keys(l)) assert.ok(!local.test(k), k);
  for (const k of Object.keys(l.features)) assert.ok(!local.test(k), k);
});

test("Local (paid): no cloud features except the listener page (Decision 2)", () => {
  const e = ent({ id: 2, plan: "local", active: true, expires_at: null });
  assert.equal(e.status, "active"); assert.equal(e.cloud, false);
  assert.ok(allows(e, "public_page")); assert.ok(!allows(e, "link_relay")); assert.ok(!allows(e, "sync"));
});

test("Station / Pro / Unlimited (paid): their own limits from the catalog", () => {
  assert.equal(ent({ id: 3, plan: "station", active: true }).limits.max_bitrate_kbps, 128);
  const pro = ent({ id: 4, plan: "pro", active: true });
  assert.equal(pro.level, "pro"); assert.equal(pro.limits.listeners.per_stream, 150); assert.ok(pro.limits.priority_support);
  const u = ent({ id: 5, plan: "unlimited", active: true });
  assert.equal(u.label, "Network");
  assert.deepEqual(u.limits.listeners, { mode: "pool", pool: 250 }); assert.equal(u.limits.hosted_streams, 5);
  assert.equal(u.limits.max_bitrate_kbps, 128); assert.equal(u.limits.stations_included, 5);
  assert.deepEqual(u.limits.extra_station, { price_monthly: 15, listeners: 50 });
});

test("RULING R1: lifetime and operator licenses are Unlimited-level forever, whatever expires_at says", () => {
  for (const plan of ["station_lifetime", "pro_lifetime", "operator"]) {
    const e = ent({ id: 6, plan, active: true, expires_at: at(NOW - 400 * DAY) });
    assert.equal(e.status, "exempt"); assert.equal(e.level, "unlimited"); assert.equal(e.cloud, true);
    // never modified: the limits it had before the 2026-10-31 prices, not the new 128 kbps Network
    assert.equal(e.label, "Network (Lifetime)");
    assert.equal(e.limits.max_bitrate_kbps, 320); assert.equal(e.limits.hosted_streams, "unlimited");
    assert.deepEqual(e.limits.listeners, { mode: "pool", pool: 250 }); assert.equal(e.limits.r2_quota_gb, 500);
  }
});

test("RULING R2: a license made in the platform app (TIER_EXEMPT_LICENSE_IDS) keeps exactly today's access", () => {
  const e = ent({ id: 7, plan: "station", active: true, expires_at: at(NOW - 400 * DAY) }, { exemptIds: new Set([7]) });
  assert.equal(e.status, "exempt"); assert.equal(e.cloud, true);
  assert.equal(e.limits.max_bitrate_kbps, 320, "today's access: the limits from before the 2026-10-31 prices");
  assert.equal(ent({ id: 7, plan: "station", active: true, expires_at: at(NOW - 400 * DAY) }).cloud, false, "only the listed id");
});

test("legacy keys: free → Founding Local (never lapses); an old paid pro/station row (no end) reads as that plan", () => {
  const f = ent({ id: 8, plan: "free", active: true, expires_at: at(NOW - 400 * DAY) });
  assert.equal(f.plan, "local"); assert.equal(f.status, "active"); assert.equal(f.cloud, false); assert.ok(f.legacy);
  assert.equal(f.label, "Free (old key)", "license 21's name stays (Jeff, 2026-11-01)");
  for (const plan of ["pro", "station"]) {
    const e = ent({ id: 9, plan, active: true, expires_at: null });
    assert.equal(e.cloud, true); assert.equal(e.level, plan);
  }
});

test("switched off (active = false) or unknown: no cloud", () => {
  assert.equal(ent({ id: 10, plan: "unlimited", active: false }).cloud, false);
  assert.equal(ent({ id: 11, plan: "mystery", active: true }).cloud, false);
  assert.equal(ent(null).status, "none");
});

// ── A PAID license's grace (Jeff, 2026-11-01): grace_until from the Stripe webhook ────────────────────────────────
test("paid grace: before grace_until the license keeps its own plan's features and limits, add-ons included", () => {
  const e = ent({ id: 5, plan: "unlimited", active: true, expires_at: null, grace_until: at(NOW + 3 * DAY), extra_stations: 1 });
  assert.equal(e.status, "grace"); assert.equal(e.level, "unlimited"); assert.equal(e.cloud, true);
  assert.equal(e.grace_until, at(NOW + 3 * DAY));
  assert.equal(e.grace_from, at(NOW + 3 * DAY - catalog.grace.past_due_days * DAY));
  assert.equal(e.limits.stations_included, 6, "add-ons still count during grace");
  assert.equal(e.paid_grace, true);
});

test("paid grace: past grace_until the license is lapsed — no cloud, plan kept, never inactive", () => {
  const e = ent({ id: 5, plan: "station", active: true, expires_at: null, grace_until: at(NOW - DAY) });
  assert.equal(e.status, "lapsed"); assert.equal(e.plan, "station"); assert.equal(e.level, null); assert.equal(e.cloud, false);
  assert.equal(e.grace_until, at(NOW - DAY));
});

test("paid grace: lifetime and platform-made licenses ignore grace_until", () => {
  assert.equal(ent({ id: 5, plan: "pro_lifetime", active: true, grace_until: at(NOW - DAY) }).status, "exempt");
  assert.equal(ent({ id: 7, plan: "station", active: true, grace_until: at(NOW - DAY) }, { exemptIds: new Set([7]) }).status, "exempt");
});
