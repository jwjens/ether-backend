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

test("catalog: the 2026-10-29 prices — no free plan; Local $9/mo or $90/yr; Station $25, Pro $49, Unlimited $79", () => {
  assert.deepEqual(Object.keys(catalog.plans), ["local", "station", "pro", "unlimited"]);
  assert.equal(catalog.plans.local.price_monthly, 9);
  assert.equal(catalog.plans.local.price_annual, 90, "annual = 10 months' price");
  assert.equal(catalog.plans.local.price_annual, catalog.plans.local.price_monthly * catalog.discounts.annual_months_charged);
  assert.equal(catalog.plans.station.price_monthly, 25); assert.equal(catalog.plans.station.per, "stream");
  assert.equal(catalog.plans.pro.price_monthly, 49); assert.equal(catalog.plans.pro.per, "stream");
  assert.equal(catalog.plans.unlimited.price_monthly, 79);
  assert.equal(catalog.addons.listeners_50.price_monthly, 10);
  assert.deepEqual(catalog.discounts.multi_station, { min_stations: 3, percent: 20 });
  assert.equal(catalog.trial.days, 15); assert.equal(catalog.trial.requires_card, false);
  assert.deepEqual(catalog.grace, { past_due_days: 7, suspended_days: 30, retention_days: 90 });
  for (const p of Object.values(catalog.plans)) assert.ok(p.price_monthly > 0, `a plan costs nothing: ${p.label}`);
});

test("catalog: Local has no cloud; the Remote Link relay is Station and up", () => {
  assert.equal(catalog.plans.local.cloud, false);
  assert.deepEqual(catalog.features.link_relay.plans, ["station", "pro", "unlimited"]);
  for (const [f, d] of Object.entries(catalog.features))
    if (!["public_page", "now_playing"].includes(f)) assert.ok(!d.plans.includes("local"), `Local carries cloud feature ${f}`);
});

test("catalog: validation refuses a bad catalog (the server would not boot on it)", () => {
  const bad = JSON.parse(JSON.stringify(catalog));
  bad.plans.free = { label: "Free", price_monthly: 0, cloud: false };
  assert.ok(P.validate(bad).some(e => /free/.test(e)));
  const bad2 = JSON.parse(JSON.stringify(catalog)); delete bad2.plans.local.price_monthly;
  assert.ok(P.validate(bad2).length);
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
  assert.deepEqual(u.limits.listeners, { mode: "pool", pool: 250 }); assert.equal(u.limits.hosted_streams, "unlimited");
});

test("RULING R1: lifetime and operator licenses are Unlimited-level forever, whatever expires_at says", () => {
  for (const plan of ["station_lifetime", "pro_lifetime", "operator"]) {
    const e = ent({ id: 6, plan, active: true, expires_at: at(NOW - 400 * DAY) });
    assert.equal(e.status, "exempt"); assert.equal(e.level, "unlimited"); assert.equal(e.cloud, true);
  }
});

test("RULING R2: a license made in the platform app (TIER_EXEMPT_LICENSE_IDS) keeps exactly today's access", () => {
  const e = ent({ id: 7, plan: "station", active: true, expires_at: at(NOW - 400 * DAY) }, { exemptIds: new Set([7]) });
  assert.equal(e.status, "exempt"); assert.equal(e.cloud, true);
  assert.equal(ent({ id: 7, plan: "station", active: true, expires_at: at(NOW - 400 * DAY) }).cloud, false, "only the listed id");
});

test("legacy keys: free → Founding Local (never lapses); an old paid pro/station row (no end) reads as that plan", () => {
  const f = ent({ id: 8, plan: "free", active: true, expires_at: at(NOW - 400 * DAY) });
  assert.equal(f.plan, "local"); assert.equal(f.status, "active"); assert.equal(f.cloud, false); assert.ok(f.legacy);
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
