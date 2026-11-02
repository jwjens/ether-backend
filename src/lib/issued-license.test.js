'use strict';
// A license issued to an email (src/lib/issued-license.js) — every case of issuing and of the automatic link, against real
// SQL (pg-mem). Each also checks that no license field moves beyond what that case allows.
const test = require("node:test");
const assert = require("node:assert");
const { newDb } = require("pg-mem");
const I = require("./issued-license");

let n = 0;
const deps = { generateLicenseKey: (plan) => `ETH-${plan.slice(0, 3).toUpperCase()}-KEY-${String(++n).padStart(4, "0")}`, hashKey: async (k) => `hash:${k}` };
async function db(sql = "") {
  const d = newDb();
  d.public.none(`
    CREATE TABLE licenses (id SERIAL PRIMARY KEY, email TEXT, plan TEXT, license_key TEXT, key_prefix TEXT, key_hash TEXT,
      expires_at TIMESTAMPTZ, active BOOLEAN DEFAULT true, stripe_subscription_id TEXT, grace_until TIMESTAMPTZ, payment_failed_at TIMESTAMPTZ);
    CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT, email_verified BOOLEAN DEFAULT false, license_key_id INT);
    CREATE TABLE stations (uuid TEXT PRIMARY KEY, license_key_id INT);`);
  const pool = new (d.adapters.createPg().Pool)();
  for (const s of sql.split(";").map((x) => x.trim()).filter(Boolean)) await pool.query(s);
  return pool;
}
const lic = async (pool, id) => (await pool.query(`SELECT * FROM licenses WHERE id = $1`, [id])).rows[0];
const user = async (pool, id) => (await pool.query(`SELECT * FROM users WHERE id = $1`, [id])).rows[0];
const count = async (pool) => (await pool.query(`SELECT COUNT(*)::int n FROM licenses`)).rows[0].n;
const future = new Date(Date.now() + 5 * 86400000).toISOString(), past = new Date(Date.now() - 5 * 86400000).toISOString();

// ── Issuing ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test("issue · no account with that email → a new license, not linked (it links on confirm)", async () => {
  const pool = await db();
  assert.deepStrictEqual(await I.planIssue(pool, { email: "New@X.test", plan: "unlimited" }), { action: "create", to_plan: "unlimited" });
  const r = await I.issueLicense(pool, { email: "New@X.test", plan: "unlimited" }, deps);
  assert.strictEqual(r.action, "create");
  const l = await lic(pool, r.license_id);
  assert.strictEqual(l.email, "new@x.test"); assert.strictEqual(l.plan, "unlimited"); assert.strictEqual(l.expires_at, null);
});

test("issue · account, email confirmed, no license → a new license linked now", async () => {
  const pool = await db("INSERT INTO users (email, email_verified) VALUES ('c@x.test', true)");
  const r = await I.issueLicense(pool, { email: "c@x.test", plan: "station" }, deps);
  assert.strictEqual(r.action, "create_and_link");
  assert.strictEqual((await user(pool, 1)).license_key_id, r.license_id);
});

test("issue · account, email NOT confirmed, no license → a new license, not linked (never on an unconfirmed email)", async () => {
  const pool = await db("INSERT INTO users (email, email_verified) VALUES ('u@x.test', false)");
  const r = await I.issueLicense(pool, { email: "u@x.test", plan: "station" }, deps);
  assert.strictEqual(r.action, "create");
  assert.strictEqual((await user(pool, 1)).license_key_id, null);
});

test("issue · the account's license is a trial → THAT license takes the plan with no end date; no second license; stations stay", async () => {
  const pool = await db(`INSERT INTO licenses (email, plan, license_key, expires_at) VALUES ('t@x.test', 'station', 'ETH-STN-TRIAL-1', '${future}');
    INSERT INTO users (email, email_verified, license_key_id) VALUES ('t@x.test', true, 1); INSERT INTO stations (uuid, license_key_id) VALUES ('s1', 1)`);
  const before = await lic(pool, 1);
  const p = await I.planIssue(pool, { email: "t@x.test", plan: "pro" });
  assert.strictEqual(p.action, "upgrade"); assert.deepStrictEqual(p.license, { id: 1, email: "t@x.test", plan: "station" });
  assert.strictEqual(p.from_plan, "station"); assert.strictEqual(p.to_plan, "pro"); assert.strictEqual(p.from_trial, true);
  const r = await I.issueLicense(pool, { email: "t@x.test", plan: "pro" }, deps);
  assert.strictEqual(r.license_id, 1); assert.strictEqual(await count(pool), 1, "no second license");
  const after = await lic(pool, 1);
  assert.strictEqual(after.plan, "pro"); assert.strictEqual(after.expires_at, null);
  assert.deepStrictEqual({ ...after, plan: before.plan, expires_at: before.expires_at }, before, "only plan and end date change");
  assert.strictEqual((await pool.query(`SELECT license_key_id FROM stations WHERE uuid = 's1'`)).rows[0].license_key_id, 1, "stations stay where they are");
});

test("issue · a Local or platform-made license (no end date) → takes the plan", async () => {
  const pool = await db(`INSERT INTO licenses (email, plan, license_key) VALUES ('l@x.test', 'local', 'ETH-LOC-1'); INSERT INTO users (email, email_verified, license_key_id) VALUES ('l@x.test', true, 1)`);
  const r = await I.issueLicense(pool, { email: "l@x.test", plan: "unlimited" }, deps);
  assert.strictEqual(r.action, "upgrade"); assert.strictEqual((await lic(pool, 1)).plan, "unlimited");
});

test("issue · a lifetime or Enterprise license → refused, nothing changes", async () => {
  for (const plan of ["station_lifetime", "pro_lifetime", "operator"]) {
    const pool = await db(`INSERT INTO licenses (email, plan, license_key) VALUES ('f@x.test', '${plan}', 'ETH-LIF-1'); INSERT INTO users (email, email_verified, license_key_id) VALUES ('f@x.test', true, 1)`);
    const before = await lic(pool, 1);
    const r = await I.issueLicense(pool, { email: "f@x.test", plan: "station" }, deps);
    assert.strictEqual(r.action, "refuse"); assert.strictEqual(r.reason, "lifetime"); assert.strictEqual(r.message, I.LIFETIME_REFUSAL);
    assert.deepStrictEqual(await lic(pool, 1), before); assert.strictEqual(await count(pool), 1);
  }
});

test("issue · a paid Stripe subscription → refused with Jeff's words, nothing changes", async () => {
  const pool = await db(`INSERT INTO licenses (email, plan, license_key, stripe_subscription_id) VALUES ('p@x.test', 'station', 'ETH-STN-PAID-1', 'sub_1'); INSERT INTO users (email, email_verified, license_key_id) VALUES ('p@x.test', true, 1)`);
  const before = await lic(pool, 1);
  const r = await I.issueLicense(pool, { email: "p@x.test", plan: "unlimited" }, deps);
  assert.strictEqual(r.action, "refuse"); assert.strictEqual(r.reason, "stripe");
  assert.strictEqual(r.message, "This account has a paid subscription; change it in Stripe first.");
  assert.deepStrictEqual(await lic(pool, 1), before); assert.strictEqual(await count(pool), 1);
});

test("issue · a Stripe subscription that failed a payment is still paid (refused); one Stripe ended is not (takes the plan)", async () => {
  let pool = await db(`INSERT INTO licenses (email, plan, license_key, stripe_subscription_id, grace_until, payment_failed_at) VALUES ('g@x.test', 'station', 'K1', 'sub_1', '${future}', '${past}'); INSERT INTO users (email, email_verified, license_key_id) VALUES ('g@x.test', true, 1)`);
  assert.strictEqual((await I.planIssue(pool, { email: "g@x.test", plan: "pro" })).action, "refuse");
  pool = await db(`INSERT INTO licenses (email, plan, license_key, stripe_subscription_id, grace_until) VALUES ('e@x.test', 'station', 'K2', 'sub_2', '${future}'); INSERT INTO users (email, email_verified, license_key_id) VALUES ('e@x.test', true, 1)`);
  assert.strictEqual((await I.planIssue(pool, { email: "e@x.test", plan: "pro" })).action, "upgrade");
});

// ── The automatic link ─────────────────────────────────────────────────────────────────────────────────────────────
const issued = (email, plan = "unlimited", extra = "") => `INSERT INTO licenses (email, plan, key_prefix, key_hash${extra ? ", " + extra.split("=")[0] : ""}) VALUES ('${email}', '${plan}', 'ETH-ISS-0001', 'hash'${extra ? ", " + extra.split("=")[1] : ""})`;

test("link · never on an unconfirmed email", async () => {
  const pool = await db(`${issued("a@x.test")}; INSERT INTO users (email, email_verified) VALUES ('a@x.test', false)`);
  assert.strictEqual(await I.linkIssuedLicense(pool, 1, { log: { log() {} } }), null);
  assert.strictEqual((await user(pool, 1)).license_key_id, null);
});

test("link · confirmed, no license → linked to the license issued to that email; the license row is unchanged", async () => {
  const pool = await db(`${issued("a@x.test")}; INSERT INTO users (email, email_verified) VALUES ('A@x.test ', true)`);
  const before = await lic(pool, 1);
  assert.deepStrictEqual(await I.linkIssuedLicense(pool, 1, { log: { log() {} } }), { linked: 1 });
  assert.strictEqual((await user(pool, 1)).license_key_id, 1);
  assert.deepStrictEqual(await lic(pool, 1), before);
});

test("link · signed in to Ether before confirming (a trial with stations) → the trial takes the issued plan, stations stay; the duplicate is switched off", async () => {
  const pool = await db(`INSERT INTO licenses (email, plan, license_key, expires_at) VALUES ('a@x.test', 'station', 'ETH-STN-TRIAL-2', '${future}'); ${issued("a@x.test", "pro")};
    INSERT INTO users (email, email_verified, license_key_id) VALUES ('a@x.test', true, 1); INSERT INTO stations (uuid, license_key_id) VALUES ('s1', 1)`);
  const r = await I.linkIssuedLicense(pool, 1, { log: { log() {} } });
  assert.deepStrictEqual(r, { upgraded: 1, from_plan: "station", to_plan: "pro", switched_off: 2 });
  const own = await lic(pool, 1), dup = await lic(pool, 2);
  assert.strictEqual(own.plan, "pro"); assert.strictEqual(own.expires_at, null); assert.strictEqual(own.license_key, "ETH-STN-TRIAL-2", "same license, same key");
  assert.strictEqual(dup.active, false);
  assert.strictEqual((await user(pool, 1)).license_key_id, 1);
  assert.strictEqual((await pool.query(`SELECT license_key_id FROM stations WHERE uuid = 's1'`)).rows[0].license_key_id, 1);
  assert.strictEqual(await I.linkIssuedLicense(pool, 1, { log: { log() {} } }), null, "runs once: the switched-off duplicate is not picked again");
});

test("link · a paid or lifetime license of its own → nothing changes", async () => {
  for (const own of [`INSERT INTO licenses (email, plan, license_key, stripe_subscription_id) VALUES ('a@x.test', 'station', 'K', 'sub_1')`,
                     `INSERT INTO licenses (email, plan, license_key) VALUES ('a@x.test', 'station_lifetime', 'K')`]) {
    const pool = await db(`${own}; ${issued("a@x.test")}; INSERT INTO users (email, email_verified, license_key_id) VALUES ('a@x.test', true, 1)`);
    const b1 = await lic(pool, 1), b2 = await lic(pool, 2);
    assert.strictEqual(await I.linkIssuedLicense(pool, 1, { log: { log() {} } }), null);
    assert.deepStrictEqual(await lic(pool, 1), b1); assert.deepStrictEqual(await lic(pool, 2), b2);
  }
});

test("link · never another account's license, never a trial, never an expired or switched-off one", async () => {
  const cases = [
    [`${issued("a@x.test")}; INSERT INTO users (email, email_verified, license_key_id) VALUES ('a@x.test', true, NULL); INSERT INTO users (email, email_verified, license_key_id) VALUES ('other@x.test', true, 1)`, "held by another account"],
    [`INSERT INTO licenses (email, plan, license_key, expires_at) VALUES ('a@x.test', 'station', 'K', '${future}'); INSERT INTO users (email, email_verified) VALUES ('a@x.test', true)`, "a trial (someone's unlinked trial)"],
    [`INSERT INTO licenses (email, plan, license_key, expires_at) VALUES ('a@x.test', 'station', 'K', '${past}'); INSERT INTO users (email, email_verified) VALUES ('a@x.test', true)`, "expired"],
    [`INSERT INTO licenses (email, plan, license_key, active) VALUES ('a@x.test', 'station', 'K', false); INSERT INTO users (email, email_verified) VALUES ('a@x.test', true)`, "switched off"],
  ];
  for (const [sql, what] of cases) {
    const pool = await db(sql);
    assert.strictEqual(await I.linkIssuedLicense(pool, 1, { log: { log() {} } }), null, what);
    assert.strictEqual((await user(pool, 1)).license_key_id, null, what);
  }
});

test("link · several issued to the same email: the newest is linked", async () => {
  const pool = await db(`${issued("a@x.test", "station")}; ${issued("a@x.test", "unlimited")}; INSERT INTO users (email, email_verified) VALUES ('a@x.test', true)`);
  assert.deepStrictEqual(await I.linkIssuedLicense(pool, 1, { log: { log() {} } }), { linked: 2 });
});
