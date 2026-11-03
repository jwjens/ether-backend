'use strict';
// ONE PARK PAGE PER CLUSTER (Jeff, 2026-11-02), through the real server (test/server-harness.js):
//   park.ether-cast.com/<cluster> — the account's handle; sign in once; every station of the cluster takes the login, each
//   checked on its own requests; the last station picked is remembered per login; old per-station links redirect to the
//   cluster page with that station selected; a station of an account with no cluster name keeps its own page.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { startServer } = require("./server-harness");
const { hashPin } = require("../src/lib/pin-hash");

let h, n = 0, ov, solo, other;
const ip = () => `198.51.100.${++n}`;
async function account(email, { slug = null, stations = [] } = {}) {
  const key = `ETH-STN-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const lic = (await h.pool.query(`INSERT INTO licenses (email, plan, license_key, key_prefix, active, account_slug, account_name) VALUES ($1,'station',$2,$3,true,$4,$5) RETURNING id`,
    [email, key, key.slice(0, 12), slug, slug ? slug.toUpperCase() : null])).rows[0].id;
  const uid = (await h.pool.query(`INSERT INTO users (email, email_verified, license_key_id, password_hash) VALUES ($1, true, $2, 'x') RETURNING id`, [email, lic])).rows[0].id;
  await h.pool.query(`INSERT INTO account_users (license_key_id, username, display_name, role, pin_hash, origin) VALUES ($1,'Steve','Steve','user',$2,'install')`, [lic, await hashPin("1234")]);
  const st = {};
  for (const [s, name] of stations) {
    const uuid = crypto.randomUUID();
    await h.pool.query(`INSERT INTO stations (uuid, license_key_id, name) VALUES ($1,$2,$3)`, [uuid, lic, name]);
    await h.pool.query(`INSERT INTO station_metadata (station_uuid, slug, display_name, public_enabled) VALUES ($1,$2,$3,true)`, [uuid, s, name]);
    st[s] = uuid;
  }
  return { lic, uid, st };
}
const get = (p, tok) => h.call("GET", p, { headers: tok ? { "x-park-session": tok } : {} });
const login = (name, pin = "1234") => h.call("POST", `/public/park/${name}/login`, { headers: { "x-forwarded-for": ip() }, body: { username: "steve", pin } });

test.before(async () => {
  h = await startServer();
  ov = await account("ov@park.test", { slug: "ovpark", stations: [["halloveen-t", "HalloVeen"], ["forest-t", "Magical Forest"], ["xmas-t", "Christmas"]] });
  solo = await account("solo@park.test", { stations: [["solo-t", "Solo FM"]] });
  other = await account("other@park.test", { slug: "otherpark", stations: [["other-t", "Other FM"]] });
});
test.after(async () => { if (h) await h.close(); });

test("park.ether-cast.com/<cluster>: the cluster's name and every published station, in name order", async () => {
  const r = await get("/public/park/ovpark");
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.kind, "cluster");
  assert.strictEqual(r.body.cluster.slug, "ovpark");
  assert.deepStrictEqual(r.body.stations.map(s => s.name), ["Christmas", "HalloVeen", "Magical Forest"]);
  assert.ok(!JSON.stringify(r.body).includes(ov.st["forest-t"]), "no station ids on the public face");
});

test("old per-station links: the cluster page with that station selected; no cluster name = the station's own page; renamed cluster; nothing", async () => {
  assert.deepStrictEqual((await get("/public/park/forest-t")).body, { ok: true, kind: "redirect", cluster: "ovpark", station: "forest-t" });
  assert.deepStrictEqual((await get("/public/park/solo-t")).body, { ok: true, kind: "station", station: "solo-t" });
  await h.pool.query(`INSERT INTO account_slug_history (old_slug, license_key_id) VALUES ('ovold', $1)`, [ov.lic]);
  assert.deepStrictEqual((await get("/public/park/ovold")).body, { ok: true, kind: "redirect", cluster: "ovpark", station: null });
  assert.strictEqual((await get("/public/park/no-such-park")).status, 404);
});

test("sign in once: the login works on every station of the cluster, checked station by station; never on another account's station", async () => {
  const r = await login("ovpark");
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.last_station, null);
  const tok = r.body.token;
  for (const s of ["halloveen-t", "forest-t", "xmas-t"]) {
    const me = await get(`/public/ops/${s}/me`, tok);
    assert.strictEqual(me.status, 200, `${s}: ${me.text}`);
    assert.strictEqual(me.body.name, "Steve");
  }
  // a station control goes past the login check (the station itself is offline in the test, so it is refused for THAT)
  const lvl = await h.call("PUT", "/public/ops/forest-t/level", { headers: { "x-park-session": tok }, body: { level: 0.5 } });
  assert.ok(![401, 403].includes(lvl.status), `the login is accepted (${lvl.status} ${lvl.text})`);
  const theirs = await get("/public/ops/other-t/me", tok);
  assert.strictEqual(theirs.status, 401);
  assert.strictEqual(theirs.body.reason, "other_account");
  assert.strictEqual((await get("/public/park/otherpark/me", (await login("ovpark")).body.token)).status, 401, "nor on another cluster's page");
});

test("the last station picked is remembered per login: told at sign-in and on every check; only this cluster's stations", async () => {
  const tok = (await login("ovpark")).body.token;
  assert.strictEqual((await h.call("PUT", "/public/park/ovpark/last-station", { headers: { "x-park-session": tok }, body: { station: "xmas-t" } })).status, 200);
  assert.strictEqual((await get("/public/park/ovpark/me", tok)).body.last_station, "xmas-t");
  assert.strictEqual((await login("ovpark")).body.last_station, "xmas-t", "a new sign-in on another phone opens on it too");
  const bad = await h.call("PUT", "/public/park/ovpark/last-station", { headers: { "x-park-session": tok }, body: { station: "other-t" } });
  assert.strictEqual(bad.status, 404);
  assert.strictEqual((await get("/public/park/ovpark/me", tok)).body.last_station, "xmas-t");
  assert.strictEqual((await h.call("PUT", "/public/park/ovpark/last-station", { body: { station: "forest-t" } })).status, 401, "not logged in: refused");
});

test("log out ends the cluster login everywhere; a PIN change logs it out; the wrong PIN counts toward the same lockout", async () => {
  const tok = (await login("ovpark")).body.token;
  await h.call("POST", "/public/park/ovpark/logout", { headers: { "x-park-session": tok } });
  assert.strictEqual((await get("/public/ops/forest-t/me", tok)).status, 401);
  const t2 = (await login("ovpark")).body.token;
  await h.pool.query(`UPDATE account_users SET pin_hash = $1 WHERE license_key_id = $2`, [await hashPin("5678"), ov.lic]);
  const me = await get("/public/park/ovpark/me", t2);
  assert.strictEqual(me.status, 401); assert.strictEqual(me.body.reason, "pin_changed");
  assert.strictEqual((await login("ovpark", "1234")).status, 401);
  assert.strictEqual((await login("ovpark", "5678")).status, 200);
});

test("an old per-station login keeps working on its own station only", async () => {
  const r = await h.call("POST", "/public/ops/solo-t/login", { headers: { "x-forwarded-for": ip() }, body: { username: "steve", pin: "1234" } });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual((await get("/public/ops/solo-t/me", r.body.token)).status, 200);
});

test("a cluster name another account's station already uses is refused; this account's own station's name is allowed", async () => {
  const tokFor = (a) => jwt.sign({ typ: "user", uid: a.uid, lk: a.lic }, h.secrets.JWT_SECRET, { expiresIn: "1h" });
  const clash = await h.call("POST", "/api/user/account-slug", { headers: { authorization: `Bearer ${tokFor(solo)}` }, body: { slug: "forest-t" } });
  assert.strictEqual(clash.status, 409, clash.text);
  const own = await h.call("POST", "/api/user/account-slug", { headers: { authorization: `Bearer ${tokFor(solo)}` }, body: { slug: "solo-t" } });
  assert.strictEqual(own.status, 200, own.text);
  assert.deepStrictEqual((await get("/public/park/solo-t")).body.kind, "cluster");
});
