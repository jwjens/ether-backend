'use strict';
// A trial that ended is NEVER refused at sign-in or at the account check (Jeff, 2026-11-01): Ether opens, playout runs,
// cloud features stay off. Through the real server (test/server-harness.js).
const test = require("node:test");
const assert = require("node:assert");
const { startServer } = require("./server-harness");

const DAY = 86400000;
let h, n = 0;
test.before(async () => {
  h = await startServer();
  const t = (await h.pool.query(`SELECT COUNT(*)::int n FROM seat_tiers WHERE is_default = true`)).rows[0].n;
  if (!t) await h.pool.query(`INSERT INTO seat_tiers (name, seat_limit, is_default) VALUES ('Test default', NULL, true)`);
});
test.after(async () => { if (h) await h.close(); });
const xff = () => ({ "x-forwarded-for": `203.0.113.${++n}` });
async function account(email, trialEndsAt) {
  const r = await h.call("POST", "/api/user/signup", { headers: xff(), body: { name: "Lapsed", email, password: "lapsed-pass-1" } });
  assert.ok(r.status === 200 || r.status === 201, r.text);
  await h.pool.query(`UPDATE users SET trial_ends_at = $1 WHERE email = $2`, [trialEndsAt, email]);
}
const activate = (email, machine = "m-lapsed") => h.call("POST", "/api/user/desktop-activate", { headers: xff(),
  body: { email, password: "lapsed-pass-1", machine_id: machine, machine_name: "Lapsed PC" } });

test("a trial that ended 30 days ago: sign-in answers normally, with the trial's past end date; the account check answers normally; cloud stays off", async () => {
  const ended = new Date(Date.now() - 30 * DAY).toISOString();
  await account("ended@lapsed.test", ended);
  const a = await activate("ended@lapsed.test");
  assert.strictEqual(a.status, 200, a.text);
  assert.ok(a.body.license_key, "a key for Ether");
  assert.strictEqual(a.body.trial, true);
  assert.strictEqual(new Date(a.body.trial_ends_at).toISOString(), ended, "the trial's own (past) end date");
  assert.strictEqual(a.body.entitlements.status, "lapsed"); assert.strictEqual(a.body.entitlements.cloud, false);
  const c = await h.call("POST", "/account/connect", { body: { license_key: a.body.license_key, machine_id: "m-lapsed" } });
  assert.strictEqual(c.status, 200, c.text);
  assert.ok(Array.isArray(c.body.stations));
  assert.strictEqual(c.body.entitlements.status, "lapsed"); assert.strictEqual(c.body.entitlements.cloud, false);
  assert.strictEqual(c.body.billing_notice.kind, "lapsed");
  const cloud = await h.call("GET", "/backup/list", { headers: { "x-license-key": a.body.license_key } });
  assert.strictEqual(cloud.status, 401, "a cloud route still refuses a lapsed key");
  // signing in again uses the same (own, lapsed) license
  const again = await activate("ended@lapsed.test");
  assert.strictEqual(again.status, 200); assert.strictEqual(again.body.license_key, a.body.license_key);
});

test("a trial that ended yesterday (inside the grace): sign-in and the account check answer normally; status grace", async () => {
  await account("yesterday@lapsed.test", new Date(Date.now() - DAY).toISOString());
  const a = await activate("yesterday@lapsed.test", "m-y");
  assert.strictEqual(a.status, 200, a.text); assert.strictEqual(a.body.trial, true);
  const c = await h.call("POST", "/account/connect", { body: { license_key: a.body.license_key, machine_id: "m-y" } });
  assert.strictEqual(c.status, 200, c.text); assert.strictEqual(c.body.entitlements.status, "grace");
});

test("a trial still running is unchanged: trial true with its future end date", async () => {
  const ends = new Date(Date.now() + 5 * DAY).toISOString();
  await account("running@lapsed.test", ends);
  const a = await activate("running@lapsed.test", "m-r");
  assert.strictEqual(a.status, 200); assert.strictEqual(a.body.trial, true);
  assert.strictEqual(new Date(a.body.trial_ends_at).toISOString(), ends);
});

test("an account with no trial at all and no license is still refused (never handed a license that does not end)", async () => {
  await account("none@lapsed.test", null);
  const a = await activate("none@lapsed.test", "m-n");
  assert.strictEqual(a.status, 403); assert.strictEqual(a.body.error, "trial_expired");
  assert.strictEqual((await h.pool.query(`SELECT license_key_id FROM users WHERE email = 'none@lapsed.test'`)).rows[0].license_key_id, null);
});
