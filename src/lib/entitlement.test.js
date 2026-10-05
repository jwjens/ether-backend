'use strict';
// P0 B6 — account entitlement honours licenses.expires_at, except lifetime/operator plans (decision 8: unchanged).
//   node --test src/lib/entitlement.test.js
const test = require("node:test");
const assert = require("node:assert");
const { newDb } = require("pg-mem");
const { userEntitlement, licenseExpired } = require("./entitlement");

const NOW = Date.parse("2026-10-05T12:00:00Z");
const PAST = new Date(NOW - 5 * 86400000), FUTURE = new Date(NOW + 5 * 86400000);

async function poolWith(plan, active, expires) {
  const pool = new (newDb().adapters.createPg().Pool)();
  await pool.query(`CREATE TABLE licenses (id SERIAL PRIMARY KEY, plan TEXT NOT NULL, active BOOLEAN, expires_at TIMESTAMPTZ)`);
  await pool.query(`INSERT INTO licenses (plan, active, expires_at) VALUES ($1,$2,$3)`, [plan, active, expires]);
  return pool;
}

test("B6: an active trial license past its expires_at no longer reads active (falls through to the trial clock)", async () => {
  const pool = await poolWith("station", true, PAST);
  const e = await userEntitlement(pool, { license_key_id: 1, trial_ends_at: PAST }, NOW);
  assert.strictEqual(e.status, "expired");
});

test("B6: before expiry it still reads active", async () => {
  const pool = await poolWith("station", true, FUTURE);
  assert.strictEqual((await userEntitlement(pool, { license_key_id: 1 }, NOW)).status, "active");
});

test("B6: a paid license with expires_at NULL is active (perpetual until Stripe cancels)", async () => {
  const pool = await poolWith("pro", true, null);
  assert.strictEqual((await userEntitlement(pool, { license_key_id: 1 }, NOW)).status, "active");
});

test("B6: lifetime and operator plans NEVER expire here — a stale expires_at reads exactly as before (decision 8)", async () => {
  for (const plan of ["station_lifetime", "pro_lifetime", "operator"]) {
    const pool = await poolWith(plan, true, PAST);
    const e = await userEntitlement(pool, { license_key_id: 1 }, NOW);
    assert.strictEqual(e.status, "active", plan);
    assert.strictEqual(e.plan, plan);
  }
});

test("B6: an inactive license is never active; the trial clock still applies", async () => {
  const pool = await poolWith("pro", false, null);
  const e = await userEntitlement(pool, { license_key_id: 1, trial_ends_at: FUTURE }, NOW);
  assert.strictEqual(e.status, "trial");
  assert.strictEqual(e.trial_days_left, 5);
});

test("B6: no license, no trial → none", async () => {
  const pool = await poolWith("pro", true, null);
  assert.strictEqual((await userEntitlement(pool, {}, NOW)).status, "none");
});

test("licenseExpired: pure rule", () => {
  assert.strictEqual(licenseExpired({ plan: "free", expires_at: PAST }, NOW), true);
  assert.strictEqual(licenseExpired({ plan: "free", expires_at: null }, NOW), false);
  assert.strictEqual(licenseExpired({ plan: "station_lifetime", expires_at: PAST }, NOW), false);
});

test("wired: index.js userEntitlement delegates to the module", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "index.js"), "utf8");
  assert.ok(/return computeUserEntitlement\(pool, u\)/.test(src));
  assert.ok(!/SELECT plan, active FROM licenses WHERE id = \$1/.test(src), "old expiry-blind query is gone");
});
