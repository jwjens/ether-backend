'use strict';
// Seat limits are data, not code (Jeff, 2026-10-26): src/lib/seat-tiers.js.
//   node --test src/lib/seat-tiers.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { newDb } = require("pg-mem");
const S = require("./seat-tiers");

async function freshDb() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await pool.query(`CREATE TABLE licenses (id SERIAL PRIMARY KEY, email TEXT, plan TEXT, license_key TEXT)`);
  // Shaped like production: a free customer, a paying customer, the two owner licenses.
  await pool.query(`INSERT INTO licenses (id, email, plan) VALUES
    (21, 'customer-a@example.com', 'free'), (22, 'owner@example.com', 'station_lifetime'),
    (23, 'customer-b@example.com', 'station'), (24, 'owner2@example.com', 'station_lifetime')`);
  return pool;
}
const tiers = async (pool) => (await pool.query(`SELECT id, name, seat_limit, is_default, default_for_plan FROM seat_tiers`)).rows;
const licRows = async (pool) => JSON.stringify((await pool.query(`SELECT * FROM licenses ORDER BY id`)).rows);

test("the seed reproduces the two old constants exactly: free = 1, every other plan = 5", async () => {
  const pool = await freshDb();
  await S.ensureSeatTiers(pool);
  const t = await tiers(pool);
  assert.deepStrictEqual(t.map(x => [x.name, x.seat_limit]).sort(), [["Free", 1], ["Standard", 5], ["Unlimited", null]]);
  assert.strictEqual((await S.seatTierFor(pool, 21)).seat_limit, 1);   // free plan → Free
  assert.strictEqual((await S.seatTierFor(pool, 23)).seat_limit, 5);   // paying plan → Standard (default)
  assert.strictEqual((await S.seatTierFor(pool, 22)).seat_limit, 5);   // owners too, until set
});

test("deploying writes no license row (licenses 21 and 23 untouched)", async () => {
  const pool = await freshDb();
  await pool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS seat_tier_id INTEGER`);   // compare like with like
  const before = await licRows(pool);
  await S.ensureSeatTiers(pool);
  assert.strictEqual(await licRows(pool), before);
});

test("the seed runs once: a second boot keeps the owner's edits", async () => {
  const pool = await freshDb();
  await S.ensureSeatTiers(pool);
  await pool.query(`UPDATE seat_tiers SET seat_limit = 8 WHERE name = 'Standard'`);
  await S.ensureSeatTiers(pool);
  const t = await tiers(pool);
  assert.strictEqual(t.length, 3);
  assert.strictEqual(t.find(x => x.name === "Standard").seat_limit, 8);
});

test("a license set to Unlimited is never at its limit; others keep theirs", async () => {
  const pool = await freshDb();
  await S.ensureSeatTiers(pool);
  const unl = (await tiers(pool)).find(x => x.name === "Unlimited");
  await pool.query(`UPDATE licenses SET seat_tier_id = $1 WHERE id IN (22, 24)`, [unl.id]);
  for (const id of [22, 24]) {
    const t = await S.seatTierFor(pool, id);
    assert.strictEqual(t.name, "Unlimited");
    assert.strictEqual(S.atSeatLimit(5, t), false);
    assert.strictEqual(S.atSeatLimit(500, t), false);
    assert.deepStrictEqual(S.seatFields(t), { seats_max: null, seats_unlimited: true, seat_tier: "Unlimited" });
  }
  assert.strictEqual(S.atSeatLimit(5, await S.seatTierFor(pool, 23)), true);
  assert.strictEqual(S.atSeatLimit(4, await S.seatTierFor(pool, 23)), false);
  assert.strictEqual(S.atSeatLimit(1, await S.seatTierFor(pool, 21)), true);
});

test("the owner's own tier beats the plan default; clearing it returns to the default", async () => {
  const pool = await freshDb();
  await S.ensureSeatTiers(pool);
  const { rows } = await pool.query(`INSERT INTO seat_tiers (name, seat_limit) VALUES ('Ten', 10) RETURNING id`);
  await pool.query(`UPDATE licenses SET seat_tier_id = $1 WHERE id = 21`, [rows[0].id]);
  assert.strictEqual((await S.seatTierFor(pool, 21)).seat_limit, 10);
  await pool.query(`UPDATE licenses SET seat_tier_id = NULL WHERE id = 21`);
  assert.strictEqual((await S.seatTierFor(pool, 21)).seat_limit, 1);
});

test("fail closed: no tier at all refuses a new seat, it never means unlimited", () => {
  assert.strictEqual(S.pickSeatTier({ id: 1, plan: "station", seat_tier_id: null }, []), null);
  assert.strictEqual(S.atSeatLimit(0, null), true);
  assert.strictEqual(S.seatRefusal(null, 0).error, "seat_tier_missing");
  assert.strictEqual(S.seatRefusal({ name: "Standard", seat_limit: 5 }, 5).error, "seat_limit_reached");
});

test("the null trap: 4 >= null is true in JavaScript, atSeatLimit is not fooled", () => {
  assert.strictEqual(4 >= null, true);
  assert.strictEqual(S.atSeatLimit(4, { seat_limit: null }), false);
});

test("index.js keeps no hard-coded seat number and every seat check goes through atSeatLimit", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8")
    .split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");                       // code, not comments
  assert.doesNotMatch(src, /SEATS_MAX|PLAN_MACHINE_LIMITS/);
  assert.doesNotMatch(src, /(activeList|active|countRow\[0\]\.n|seatsUsed)(\.length)?\s*>=\s*/);
  assert.ok((src.match(/SEATS\.atSeatLimit\(/g) || []).length >= 5);
});
