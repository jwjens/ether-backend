'use strict';
// GET /api/platform/licenses through the real server: every license carries its status from the server's plan rules,
// the date that applies, how it is paid and when a computer last checked in. Reading it writes nothing.
const test = require("node:test");
const assert = require("node:assert");
const jwt = require("jsonwebtoken");
const { startServer, SECRETS } = require("./server-harness");

let h, auth;
test.before(async () => {
  h = await startServer();
  auth = { headers: { authorization: `Bearer ${jwt.sign({ platform: true }, SECRETS.JWT_SECRET)}` } };
  const q = (s, p) => h.pool.query(s, p);
  await q(`INSERT INTO licenses (email, license_key, plan, expires_at) VALUES ('trial@x.test', 'ETH-TRIAL', 'station', NOW() + INTERVAL '6 days')`);
  await q(`INSERT INTO licenses (email, license_key, plan, expires_at) VALUES ('life@x.test', 'ETH-LIFE', 'station_lifetime', NOW() - INTERVAL '90 days')`);
  await q(`INSERT INTO licenses (email, license_key, plan, expires_at) VALUES ('gone@x.test', 'ETH-GONE', 'station', NOW() - INTERVAL '40 days')`);
  await q(`INSERT INTO license_activations (license_key, machine_id, last_seen) VALUES ('ETH-TRIAL', 'm1', '2026-10-20T10:00:00Z')`);
});
test.after(async () => { if (h) await h.close(); });

test("each license: Trial with days left and its end date, Lifetime, Lapsed; last check-in; no Stripe", async () => {
  const before = (await h.pool.query(`SELECT id, plan, active, expires_at FROM licenses ORDER BY id`)).rows;
  const r = await h.call("GET", "/api/platform/licenses", auth);
  assert.equal(r.status, 200, r.text);
  const by = Object.fromEntries(r.body.licenses.map(l => [l.email, l]));

  const t = by["trial@x.test"].plan_status;
  assert.equal(t.status, "trial");
  assert.ok(t.days_left === 6 || t.days_left === 7, String(t.days_left));
  assert.equal(t.date_kind, "trial_ends");
  assert.equal(t.paid_through, null);
  assert.equal(t.tier_choice, "station");
  assert.equal(new Date(by["trial@x.test"].last_seen).toISOString(), "2026-10-20T10:00:00.000Z");

  assert.equal(by["life@x.test"].plan_status.status, "lifetime");
  assert.equal(by["life@x.test"].plan_status.tier_choice, "lifetime");
  assert.equal(by["gone@x.test"].plan_status.status, "lapsed");
  assert.equal(by["gone@x.test"].last_seen, null);

  assert.deepEqual(r.body.tier_options.map(o => o.label), ["Local", "Station", "Pro", "Unlimited", "Lifetime"]);
  assert.ok(!("stripe_subscription_id" in by["trial@x.test"]), "subscription id is not sent to the page");
  const after = (await h.pool.query(`SELECT id, plan, active, expires_at FROM licenses ORDER BY id`)).rows;
  assert.deepEqual(after, before, "reading the page changed a license");
});

test("the Tier dropdown still refuses a key the server does not know", async () => {
  const id = (await h.pool.query(`SELECT id FROM licenses WHERE email = 'gone@x.test'`)).rows[0].id;
  const bad = await h.call("PATCH", `/api/platform/licenses/${id}`, { ...auth, body: { plan: "enterprise_plus" } });
  assert.equal(bad.status, 400);
  assert.equal((await h.pool.query(`SELECT plan FROM licenses WHERE id = $1`, [id])).rows[0].plan, "station");
});

test("Unlimited: the dropdown stores the unlimited key, which signs in and reads as Unlimited, not Lifetime", async () => {
  const id = (await h.pool.query(`SELECT id FROM licenses WHERE email = 'trial@x.test'`)).rows[0].id;
  const r = await h.call("PATCH", `/api/platform/licenses/${id}`, { ...auth, body: { plan: "unlimited" } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await h.pool.query(`SELECT plan FROM licenses WHERE id = $1`, [id])).rows[0].plan, "unlimited");
  const list = await h.call("GET", "/api/platform/licenses", auth);
  const l = list.body.licenses.find(x => x.id === id);
  assert.equal(l.plan_status.tier_choice, "unlimited");
  assert.equal(l.plan_status.status, "trial", "its trial end still applies: it expires like the other paid plans");
  assert.ok(list.body.tiers.includes("unlimited"));
  // (Generating a new key is not run here: pg-mem refuses the NULL license_key that production Postgres stores.)
});
