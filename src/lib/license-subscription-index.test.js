'use strict';
// One license per Stripe subscription: the index is made on a clean table; with duplicates already there it is not,
// the server still starts, and no license is changed.
//   node --test src/lib/license-subscription-index.test.js
const test = require("node:test");
const assert = require("node:assert");
const { newDb } = require("pg-mem");
const IDX = require("./license-subscription-index");

async function pool() {
  const p = new (newDb().adapters.createPg().Pool)();
  await p.query(`CREATE TABLE licenses (id SERIAL PRIMARY KEY, email TEXT, plan TEXT, active BOOLEAN DEFAULT true,
    stripe_subscription_id TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  return p;
}
const quiet = { warn() {}, error() {}, log() {} };

test("clean table: the index is made; a second license for the same subscription is then refused; licenses without a subscription are unaffected", async () => {
  const p = await pool();
  await p.query(`INSERT INTO licenses (email, plan, stripe_subscription_id) VALUES ('a@x','station','sub_1'), ('t1@x','station',NULL), ('t2@x','station',NULL)`);
  const r = await IDX.ensureOneLicensePerSubscription(p, quiet);
  assert.deepStrictEqual(r, { made: true, duplicates: [] });
  await assert.rejects(p.query(`INSERT INTO licenses (email, plan, stripe_subscription_id) VALUES ('b@x','station','sub_1')`));
  await p.query(`INSERT INTO licenses (email, plan, stripe_subscription_id) VALUES ('t3@x','station',NULL)`);
  assert.deepStrictEqual(await IDX.ensureOneLicensePerSubscription(p, quiet), { made: true, duplicates: [] }, "running again is harmless");
});

test("duplicates already there: not made, they are reported with emails, nothing thrown, no license changed", async () => {
  const p = await pool();
  await p.query(`INSERT INTO licenses (email, plan, stripe_subscription_id) VALUES ('d@x','station','sub_9'), ('d@x','station','sub_9'), ('ok@x','pro','sub_2')`);
  const before = (await p.query(`SELECT * FROM licenses ORDER BY id`)).rows;
  const errs = [];
  const r = await IDX.ensureOneLicensePerSubscription(p, { ...quiet, error: (m) => errs.push(m) });
  assert.strictEqual(r.made, false);
  assert.deepStrictEqual(r.duplicates.map((d) => [d.subscription, d.licenses.map((l) => [l.id, l.email])]), [["sub_9", [[1, "d@x"], [2, "d@x"]]]]);
  assert.match(errs[0], /NOT made: 1 subscription\(s\).*sub_9: 1 d@x, 2 d@x.*No license was changed/);
  assert.deepStrictEqual((await p.query(`SELECT * FROM licenses ORDER BY id`)).rows, before);
  await p.query(`INSERT INTO licenses (email, plan, stripe_subscription_id) VALUES ('d@x','station','sub_9')`);   // no index: still possible
});

test("wired: initDB makes it, right after the billing columns", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "index.js"), "utf8");
  assert.ok(/await require\("\.\/lib\/license-subscription-index"\)\.ensureOneLicensePerSubscription\(pool\);/.test(src));
});
