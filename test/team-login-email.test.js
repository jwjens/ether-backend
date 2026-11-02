'use strict';
// The dashboard's team sign-in by ACCOUNT EMAIL + username + PIN (Jeff, 2026-11-02), option B, through the real server
// (test/server-harness.js):
//   · wrong PINs never lock the person — account_users.failed_attempts / locked_until are never touched;
//   · guessing is slowed per DEVICE and per ADDRESS (src/lib/dashboard-throttle.js: 5 wrong → 15 minutes);
//   · no dashboard failure locks the PIN at the Park page (and the Ether console's PINs never come from the server —
//     the desktop's own test, src/lib/consolePinLocal.test.ts).
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { startServer } = require("./server-harness");
const { hashPin } = require("../src/lib/pin-hash");

let h, n = 0;
const nextIp = () => `198.51.100.${++n}`;
const login = (body, ip = nextIp()) => h.call("POST", "/api/auth/login", { headers: { "x-forwarded-for": ip }, body });
const parkLogin = (slug, body, ip = nextIp()) => h.call("POST", `/public/ops/${slug}/login`, { headers: { "x-forwarded-for": ip }, body });
const dev = () => crypto.randomBytes(12).toString("hex");
async function account(email, { plan = "station", expires_at = null, active = true, key } = {}) {
  const lic = (await h.pool.query(`INSERT INTO licenses (email, plan, license_key, key_prefix, expires_at, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [email, plan, key, key.slice(0, 12), expires_at, active])).rows[0].id;
  await h.pool.query(`INSERT INTO users (email, email_verified, license_key_id, password_hash) VALUES ($1, true, $2, 'x')`, [email, lic]);
  const uid = (await h.pool.query(`INSERT INTO account_users (license_key_id, username, display_name, role, pin_hash, origin) VALUES ($1, 'Steve', 'Steve', 'user', $2, 'install') RETURNING id`, [lic, await hashPin("1234")])).rows[0].id;
  return { lic, uid };
}
const lockFields = async (id) => (await h.pool.query(`SELECT failed_attempts, locked_until FROM account_users WHERE id = $1`, [id])).rows[0];
let park;
test.before(async () => {
  h = await startServer();
  await account("station@team.test", { key: "ETH-STN-TEAM-0001" });
  await account("ended@team.test", { key: "ETH-STN-ENDD-0001", expires_at: new Date(Date.now() - 86400000).toISOString() });
  await account("forever@team.test", { key: "ETH-STN-LIFE-0001", plan: "station_lifetime", expires_at: new Date(Date.now() - 200 * 86400000).toISOString() });
  await account("off@team.test", { key: "ETH-STN-OFFF-0001", active: false });
  park = await account("park@team.test", { key: "ETH-STN-PARK-0001" });
  const uuid = crypto.randomUUID();
  await h.pool.query(`INSERT INTO stations (uuid, license_key_id, name) VALUES ($1, $2, 'Park Test')`, [uuid, park.lic]);
  await h.pool.query(`INSERT INTO station_metadata (station_uuid, slug, display_name, public_enabled) VALUES ($1, 'park-team-test', 'Park Test', true)`, [uuid]);
});
test.after(async () => { if (h) await h.close(); });

test("account email + username + PIN signs in (any case, spaces trimmed)", async () => {
  const r = await login({ email: "  Station@Team.TEST ", username: "steve", pin: "1234", device_id: dev() });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.user.username, "Steve");
  assert.strictEqual((await h.call("GET", "/api/auth/me", { headers: { authorization: `Bearer ${r.body.token}` } })).status, 200);
});

test("wrong email, unknown email, wrong username, wrong PIN: the same answer — an email is never confirmed or denied", async () => {
  for (const body of [{ email: "nobody@team.test", username: "Steve", pin: "1234" }, { email: "station@team.test", username: "Bob", pin: "1234" },
                      { email: "station@team.test", username: "Steve", pin: "9999" }]) {
    const r = await login(body);
    assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error, "invalid_credentials");
  }
});

test("a switched-off license or an ended trial: refused; a lifetime license is never expired", async () => {
  assert.strictEqual((await login({ email: "off@team.test", username: "Steve", pin: "1234" })).status, 401);
  assert.strictEqual((await login({ email: "ended@team.test", username: "Steve", pin: "1234" })).status, 401);
  assert.strictEqual((await login({ email: "forever@team.test", username: "Steve", pin: "1234" })).status, 200);
});

test("B · 20 wrong PINs (from many devices and addresses) never lock the person: lock fields untouched, the right PIN still works", async () => {
  const { uid } = (await h.pool.query(`SELECT id AS uid FROM account_users WHERE license_key_id = (SELECT license_key_id FROM users WHERE email = 'station@team.test')`)).rows[0];
  for (let i = 0; i < 20; i++) assert.strictEqual((await login({ email: "station@team.test", username: "Steve", pin: "0000", device_id: dev() })).status, 401);
  assert.deepStrictEqual(await lockFields(uid), { failed_attempts: 0, locked_until: null });
  assert.strictEqual((await login({ email: "station@team.test", username: "Steve", pin: "1234", device_id: dev() })).status, 200);
});

test("B · one ADDRESS that guesses 5 times waits 15 minutes — whatever device id it sends, even with the right PIN; others are unaffected", async () => {
  const ip = "203.0.113.77";
  for (let i = 0; i < 4; i++) assert.strictEqual((await login({ email: "station@team.test", username: "Steve", pin: "0000", device_id: dev() }, ip)).status, 401);
  const fifth = await login({ email: "station@team.test", username: "Steve", pin: "0000", device_id: dev() }, ip);
  assert.strictEqual(fifth.status, 401);
  const r = await login({ email: "station@team.test", username: "Steve", pin: "1234", device_id: dev() }, ip);
  assert.strictEqual(r.status, 429); assert.strictEqual(r.body.error, "too_many_attempts");
  const mins = (new Date(r.body.until).getTime() - Date.now()) / 60000;
  assert.ok(mins > 14 && mins <= 15, `waits about 15 minutes (${mins.toFixed(1)})`);
  assert.strictEqual((await login({ email: "station@team.test", username: "Steve", pin: "1234", device_id: dev() })).status, 200, "the same person elsewhere signs in");
});

test("B · one DEVICE that guesses 5 times waits — even when it changes address", async () => {
  const d = dev();
  for (let i = 0; i < 5; i++) await login({ email: "station@team.test", username: "Steve", pin: "0000", device_id: d });
  const r = await login({ email: "station@team.test", username: "Steve", pin: "1234", device_id: d });
  assert.strictEqual(r.status, 429);
});

test("B · unknown emails count too (guessing which email is real is slowed the same way)", async () => {
  const ip = "203.0.113.88";
  for (let i = 0; i < 5; i++) await login({ email: `guess${i}@nowhere.test`, username: "Steve", pin: "0000" }, ip);
  assert.strictEqual((await login({ email: "station@team.test", username: "Steve", pin: "1234" }, ip)).status, 429);
});

test("B · a successful sign-in clears its device's count (a typo or two doesn't add up across the day)", async () => {
  const d = dev();
  for (let i = 0; i < 4; i++) await login({ email: "station@team.test", username: "Steve", pin: "0000", device_id: d });
  assert.strictEqual((await login({ email: "station@team.test", username: "Steve", pin: "1234", device_id: d })).status, 200);
  for (let i = 0; i < 4; i++) assert.strictEqual((await login({ email: "station@team.test", username: "Steve", pin: "0000", device_id: d })).status, 401);
});

test("no dashboard failure locks the PIN at the Park page: after 25 wrong dashboard PINs the Park page signs in with the right PIN", async () => {
  for (let i = 0; i < 25; i++) await login({ email: "park@team.test", username: "Steve", pin: "0000", device_id: dev() });
  assert.deepStrictEqual(await lockFields(park.uid), { failed_attempts: 0, locked_until: null });
  const r = await parkLogin("park-team-test", { username: "Steve", pin: "1234" });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.ok, true);
});

test("the Park page keeps its own lockout (unchanged), and a Park lockout doesn't touch the dashboard's", async () => {
  for (let i = 0; i < 5; i++) await parkLogin("park-team-test", { username: "Steve", pin: "0000" });
  assert.ok((await lockFields(park.uid)).locked_until, "Park locked its user, as before");
  assert.strictEqual((await parkLogin("park-team-test", { username: "Steve", pin: "1234" })).status, 423);
  assert.strictEqual((await login({ email: "park@team.test", username: "Steve", pin: "1234", device_id: dev() })).status, 200, "the dashboard is separate");
});

test("an older dashboard page sending the license key still works (same rules); neither email nor key → missing_fields", async () => {
  assert.strictEqual((await login({ license_key: "ETH-STN-TEAM-0001", username: "Steve", pin: "1234" })).status, 200);
  const r = await login({ username: "Steve", pin: "1234" });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error, "missing_fields");
});
