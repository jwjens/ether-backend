'use strict';
// The test harness's pg-mem stand-in for licenses.license_key (test/server-harness.js): like production Postgres, any
// number of hash-only licenses (license_key NULL) store, and a key that IS set stays unique.
//   node --test test/server-harness.test.js
const test = require("node:test");
const assert = require("node:assert");
const { startServer } = require("./server-harness");

let h;
test.before(async () => { h = await startServer(); });
test.after(async () => { if (h) await h.close(); });

test("hash-only licenses (license_key NULL) store side by side, and stay NULL", async () => {
  await h.pool.query(`INSERT INTO licenses (email, plan, key_prefix, key_hash) VALUES ('a@h.test','station','ETH-STN-AAAA','h1')`);
  await h.pool.query(`INSERT INTO licenses (email, plan, key_prefix, key_hash) VALUES ('b@h.test','station','ETH-STN-BBBB','h2')`);
  const rows = (await h.pool.query(`SELECT license_key FROM licenses WHERE email IN ('a@h.test','b@h.test')`)).rows;
  assert.deepStrictEqual(rows.map(r => r.license_key), [null, null]);
});

test("a license key that is set is still unique", async () => {
  await h.pool.query(`INSERT INTO licenses (email, plan, license_key) VALUES ('c@h.test','station','ETH-STN-SAME-0001')`);
  await assert.rejects(h.pool.query(`INSERT INTO licenses (email, plan, license_key) VALUES ('d@h.test','station','ETH-STN-SAME-0001')`));
});

test("the real boot (initDB) makes the one-license-per-subscription index: a second license for a subscription is refused", async () => {
  await h.pool.query(`INSERT INTO licenses (email, plan, stripe_subscription_id) VALUES ('s1@h.test','station','sub_boot_1')`);
  await assert.rejects(h.pool.query(`INSERT INTO licenses (email, plan, stripe_subscription_id) VALUES ('s2@h.test','station','sub_boot_1')`));
});
