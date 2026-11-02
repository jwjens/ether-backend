'use strict';
// Lifetime and operator licenses never expire, whatever end date they carry (Jeff, 2026-11-01): the account check and
// every cloud route accept them; a trial with the same past date is still lapsed for cloud. Real server, test database.
const test = require("node:test");
const assert = require("node:assert");
const { startServer } = require("./server-harness");

let h;
test.before(async () => {
  h = await startServer();
  const t = (await h.pool.query(`SELECT COUNT(*)::int n FROM seat_tiers WHERE is_default = true`)).rows[0].n;
  if (!t) await h.pool.query(`INSERT INTO seat_tiers (name, seat_limit, is_default) VALUES ('Test default', NULL, true)`);
});
test.after(async () => { if (h) await h.close(); });
const past = new Date(Date.now() - 100 * 86400000).toISOString();
const add = (key, plan) => h.pool.query(`INSERT INTO licenses (email, plan, license_key, key_prefix, expires_at, active) VALUES ($1,$2,$3,$4,$5,true)`,
  [`${plan}@life.test`, plan, key, key.slice(0, 12), past]);

for (const plan of ["station_lifetime", "pro_lifetime", "operator"]) {
  test(`${plan} with an end date 100 days ago: the account check answers normally (exempt) and a cloud route accepts the key`, async () => {
    const key = `ETH-LIF-${plan.slice(0, 4).toUpperCase()}-0001`;
    await add(key, plan);
    const c = await h.call("POST", "/account/connect", { body: { license_key: key, machine_id: `m-${plan}` } });
    assert.strictEqual(c.status, 200, c.text);
    assert.strictEqual(c.body.entitlements.status, "exempt");
    assert.strictEqual(c.body.billing_notice, null, "no trial-ended notice for a lifetime license");
    const cloud = await h.call("GET", "/backup/list", { headers: { "x-license-key": key } });
    assert.notStrictEqual(cloud.status, 401, "not refused as expired");
  });
}

test("a trial with the same past end date is still lapsed for cloud (401 on a cloud route)", async () => {
  await add("ETH-STN-TRIA-0001", "station");
  const cloud = await h.call("GET", "/backup/list", { headers: { "x-license-key": "ETH-STN-TRIA-0001" } });
  assert.strictEqual(cloud.status, 401);
});
