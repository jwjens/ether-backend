'use strict';
// "As people log in, the pay tier has to be [there]; restrictions need to align" (Jeff, 2026-10-29): every sign-in reply
// carries what the account's plan allows, computed by the server from config/plans.json. Real server, pg-mem.
const test = require("node:test");
const assert = require("node:assert");
const jwt = require("jsonwebtoken");
const { startServer } = require("./server-harness");

let h;
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
async function license(plan, key, expiresAt = null) {
  return (await h.pool.query(
    `INSERT INTO licenses (email, plan, license_key, key_prefix, expires_at, active) VALUES ($1, $2, $3, $4, $5, true) RETURNING *`,
    [`${key.toLowerCase()}@example.org`, plan, key, key.slice(0, 12), expiresAt])).rows[0];
}
test.before(async () => { h = await startServer(); });
test.after(async () => { if (h) await h.close(); });

test("sign-up → desktop sign-in: a brand-new 15-day trial, full access, and the reply says so", async () => {
  const s = await h.call("POST", "/api/user/signup", { body: { email: "trial@example.org", password: "password-1" } });
  assert.equal(s.status, 200, s.text);
  const a = await h.call("POST", "/api/user/desktop-activate", { body: { email: "trial@example.org", password: "password-1", machine_id: "m-trial" } });
  assert.equal(a.status, 200, a.text);
  const e = a.body.entitlements;
  assert.equal(e.status, "trial"); assert.equal(e.cloud, true);
  assert.ok(e.features.sync && e.features.link_relay);
  const days = (Date.parse(e.trial_ends_at) - Date.now()) / DAY;
  assert.ok(days > 14.9 && days <= 15, `trial is ${days} days`);
  const me = await h.call("GET", "/api/user/me", { headers: { authorization: `Bearer ${s.body.token}` } });
  assert.equal(me.body.entitlements.status, "trial");
});

test("/account/connect (the desktop's sign-in to its stations) carries the plan's allowances", async () => {
  await license("local", "ETH-PRO-LOCL-0001-AAAA");
  const r = await h.call("POST", "/account/connect", { body: { license_key: "ETH-PRO-LOCL-0001-AAAA", machine_id: "m-local" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.entitlements.plan, "local");
  assert.equal(r.body.entitlements.cloud, false);
  assert.equal(r.body.entitlements.features.link_relay, false, "Local has the relay");
  assert.equal(r.body.entitlements.features.public_page, true);
});

test("a trial that ended: connect still answers trial_expired as before, and now says the account is in its grace", async () => {
  await license("station", "ETH-STN-GRCE-0001-AAAA", iso(Date.now() - 2 * DAY));
  const r = await h.call("POST", "/account/connect", { body: { license_key: "ETH-STN-GRCE-0001-AAAA", machine_id: "m-g" } });
  assert.equal(r.status, 401); assert.equal(r.body.error, "trial_expired");
  assert.equal(r.body.entitlements.status, "grace");
  const g = await h.call("GET", "/api/entitlements", { headers: { "x-license-key": "ETH-STN-GRCE-0001-AAAA" } });
  assert.equal(g.status, 200); assert.equal(g.body.entitlements.status, "grace");
});

test("past the grace: lapsed — no cloud; the server never says anything about audio or playout", async () => {
  await license("station", "ETH-STN-LAPS-0001-AAAA", iso(Date.now() - 30 * DAY));
  const g = await h.call("GET", "/api/entitlements", { headers: { "x-license-key": "ETH-STN-LAPS-0001-AAAA" } });
  assert.equal(g.body.entitlements.status, "lapsed"); assert.equal(g.body.entitlements.cloud, false);
});

test("a lifetime license with a stale expires_at: Unlimited-level, and its row is not written", async () => {
  const before = await license("station_lifetime", "ETH-STN-LIFE-0001-AAAA", iso(Date.now() - 300 * DAY));
  const g = await h.call("GET", "/api/entitlements", { headers: { "x-license-key": "ETH-STN-LIFE-0001-AAAA" } });
  assert.equal(g.body.entitlements.status, "exempt"); assert.equal(g.body.entitlements.level, "unlimited");
  const after = (await h.pool.query(`SELECT * FROM licenses WHERE id = $1`, [before.id])).rows[0];
  assert.deepEqual(after, before, "the lifetime row changed");
});

test("GET /api/entitlements: a wrong key or no sign-in is refused", async () => {
  assert.equal((await h.call("GET", "/api/entitlements", { headers: { "x-license-key": "ETH-STN-NOPE-0000-0000" } })).status, 401);
  assert.equal((await h.call("GET", "/api/entitlements")).status, 401);
  const forged = jwt.sign({ uid: 1, typ: "user" }, "not-the-secret");
  assert.equal((await h.call("GET", "/api/entitlements", { headers: { authorization: `Bearer ${forged}` } })).status, 401);
});
