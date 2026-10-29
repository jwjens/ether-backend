'use strict';
// The plan check on every cloud route (src/lib/feature-gate.js). Real server, real routes, pg-mem.
// Jeff, 2026-10-29: "The server is the source of truth for cloud features and enforces them on every cloud route.
// Local features never read an entitlement." Shadow first: nobody is refused until PLAN_ENFORCE=1.
const test = require("node:test");
const assert = require("node:assert");
const jwt = require("jsonwebtoken");
const { startServer } = require("./server-harness");
const { featureFor, CLOUD_ROUTES } = require("../src/lib/feature-gate");

let h, platform;
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const keys = {};
async function license(name, plan, expiresAt = null) {
  const key = `ETH-STN-${name.toUpperCase().padEnd(4, "X").slice(0, 4)}-0000-${String(Object.keys(keys).length).padStart(4, "0")}`;
  const row = (await h.pool.query(
    `INSERT INTO licenses (email, plan, license_key, key_prefix, expires_at, active) VALUES ($1, $2, $3, $4, $5, true) RETURNING *`,
    [`${name}@example.org`, plan, key, key.slice(0, 12), expiresAt])).rows[0];
  keys[name] = { key, id: row.id, email: row.email };
  return row;
}
const backupList = (name) => h.call("POST", "/backup/list", { body: { license_key: keys[name].key } });
const relay = (name) => h.call("GET", "/api/link/relay/sessions", {
  headers: { authorization: `Bearer ${jwt.sign({ uid: keys[name].uid, typ: "user" }, h.secrets.JWT_SECRET)}` } });

test.before(async () => {
  h = await startServer();
  await license("local", "local");
  await license("trial", "station", iso(Date.now() + 10 * DAY));
  await license("grace", "station", iso(Date.now() - 2 * DAY));
  await license("lapsed", "station", iso(Date.now() - 30 * DAY));
  await license("life", "station_lifetime", iso(Date.now() - 300 * DAY));
  await license("paid", "station");
  let uid = 100;
  for (const name of Object.keys(keys)) {
    keys[name].uid = ++uid;
    await h.pool.query(`INSERT INTO users (id, email, password_hash, email_verified, license_key_id) VALUES ($1, $2, 'x', true, $3)`,
      [uid, `u-${name}@example.org`, keys[name].id]);
  }
  platform = (await h.call("POST", "/api/platform/login", { body: { secret: h.secrets.ETHER_PLATFORM_SECRET } })).body.token;
});
test.after(async () => { delete process.env.PLAN_ENFORCE; if (h) await h.close(); });

test("SHADOW (default): nobody is refused by plan; who WOULD be is recorded, with the license's email", async () => {
  delete process.env.PLAN_ENFORCE;
  const r = await backupList("local");
  assert.notEqual(r.status, 402, "shadow refused");
  const rep = (await h.call("GET", "/api/platform/plan-refusals", { headers: { authorization: `Bearer ${platform}` } })).body;
  assert.equal(rep.mode, "shadow");
  const row = rep.refusals.find(x => x.license_id === keys.local.id && x.feature === "cloud_backup");
  assert.ok(row, JSON.stringify(rep));
  assert.equal(row.email, keys.local.email); assert.equal(row.plan, "local");
});

test("the refusal report is platform-only", async () => {
  assert.equal((await h.call("GET", "/api/platform/plan-refusals")).status, 401);
  const owner = jwt.sign({ uid: 1, lk: keys.paid.id, role: "admin", typ: "owner" }, h.secrets.JWT_SECRET);
  assert.notEqual((await h.call("GET", "/api/platform/plan-refusals", { headers: { authorization: `Bearer ${owner}` } })).status, 200);
});

test("ENFORCE: Local and a lapsed account get 402 plan_required on a cloud route; trial, grace, paid and lifetime pass", async () => {
  process.env.PLAN_ENFORCE = "1";
  try {
    for (const name of ["local", "lapsed"]) {
      const r = await backupList(name);
      assert.equal(r.status, 402, `${name}: ${r.text}`);
      assert.equal(r.body.error, "plan_required"); assert.equal(r.body.feature, "cloud_backup");
      assert.deepEqual(r.body.required_plans, ["station", "pro", "unlimited"]);
    }
    for (const name of ["trial", "grace", "paid", "life"]) assert.notEqual((await backupList(name)).status, 402, name);
  } finally { delete process.env.PLAN_ENFORCE; }
});

test("ENFORCE: the Remote Link relay is Station and up (a signed-in user, judged by their own license)", async () => {
  process.env.PLAN_ENFORCE = "1";
  try {
    const r = await relay("local");
    assert.equal(r.status, 402, r.text); assert.equal(r.body.feature, "link_relay");
    assert.notEqual((await relay("paid")).status, 402);
  } finally { delete process.env.PLAN_ENFORCE; }
});

test("ENFORCE: a request with no account it can find goes to the route's own sign-in check (401), never 402", async () => {
  process.env.PLAN_ENFORCE = "1";
  try {
    const r = await h.call("POST", "/backup/list", { body: { license_key: "ETH-STN-NOPE-0000-9999" } });
    assert.equal(r.status, 401);
    assert.equal((await h.call("POST", "/backup/list", { body: {} })).status, 400);
  } finally { delete process.env.PLAN_ENFORCE; }
});

test("ENFORCE: sign-in and plan reads are never behind the plan check (a lapsed account can always sign in and pay)", async () => {
  process.env.PLAN_ENFORCE = "1";
  try {
    assert.equal((await h.call("GET", "/public/plans")).status, 200);
    const c = await h.call("POST", "/account/connect", { body: { license_key: keys.local.key, machine_id: "m-x" } });
    assert.equal(c.status, 200, c.text);
    const e = await h.call("GET", "/api/entitlements", { headers: { "x-license-key": keys.lapsed.key } });
    assert.equal(e.status, 200);
  } finally { delete process.env.PLAN_ENFORCE; }
});

test("the list: cloud routes map to their feature; sign-in, plans and local-only routes are not on it", () => {
  const cases = {
    "POST /backup/list": "cloud_backup", "POST /sync/mutations": "sync", "GET /library/snapshot": "r2_library",
    "POST /audio/upload-url": "r2_library", "POST /api/cmd": "web_remote", "GET /api/cmd-stream": "web_remote",
    "GET /api/link/relay/sessions": "link_relay", "GET /api/link/machines": "link_pairing",
    "POST /api/now-playing": "now_playing", "PUT /public/ops/x/level": "park_ops", "POST /invite/send": "show_guests",
    "GET /api/accounts/5/members": "members", "GET /api/account/station/u/analytics": "analytics_web",
    "POST /account/connect": null, "POST /api/user/desktop-activate": null, "POST /api/auth/owner-login": null,
    "GET /public/plans": null, "GET /api/entitlements": null, "POST /public/ops/x/login": null, "GET /health": null,
    "POST /validate": null, "GET /api/now-playing": null,
  };
  for (const [k, f] of Object.entries(cases)) { const [m, p] = k.split(" "); assert.equal(featureFor(m, p), f, k); }
  const catalog = require("../src/lib/plans").load();
  for (const [, , f] of CLOUD_ROUTES) assert.ok(catalog.features[f], `route feature ${f} is not in config/plans.json`);
});
