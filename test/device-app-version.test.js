'use strict';
// The Ether version of each device, recorded from the desktop's own requests and shown on the platform's machine list.
// Real server (test/server-harness.js).
const test = require("node:test");
const assert = require("node:assert");
const { startServer } = require("./server-harness");

let h, platform, n = 0;
test.before(async () => {
  h = await startServer();
  const t = (await h.pool.query(`SELECT COUNT(*)::int n FROM seat_tiers WHERE is_default = true`)).rows[0].n;
  if (!t) await h.pool.query(`INSERT INTO seat_tiers (name, seat_limit, is_default) VALUES ('Test default', NULL, true)`);
  platform = (await h.call("POST", "/api/platform/login", { body: { secret: h.secrets.ETHER_PLATFORM_SECRET } })).body.token;
});
test.after(async () => { if (h) await h.close(); });
const UA = (v) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Ether/${v} Chrome/130.0 Electron/33.4.11 Safari/537.36`;
const hdr = (extra = {}) => ({ "x-forwarded-for": `198.51.100.${++n}`, ...extra });
const row = async (machine) => (await h.pool.query(`SELECT app_version FROM license_activations WHERE machine_id = $1`, [machine])).rows[0];

test("a 4.6.57-style sign-in (version only in the User-Agent) is recorded; a later check-in from a newer build updates it; the platform shows it", async () => {
  const email = "ver@device.test";
  const su = await h.call("POST", "/api/user/signup", { headers: hdr(), body: { name: "Ver", email, password: "ver-pass-123" } });
  assert.ok(su.status === 200 || su.status === 201, su.text);
  const a = await h.call("POST", "/api/user/desktop-activate", { headers: hdr({ "user-agent": UA("4.6.57") }),
    body: { email, password: "ver-pass-123", machine_id: "ver-machine", machine_name: "Studio PC" } });
  assert.strictEqual(a.status, 200, a.text);
  assert.strictEqual((await row("ver-machine")).app_version, "4.6.57");
  // the 20-second account check from a newer build keeps it current
  const c = await h.call("POST", "/account/connect", { headers: { "user-agent": UA("4.6.71") }, body: { license_key: a.body.license_key, machine_id: "ver-machine" } });
  assert.strictEqual(c.status, 200, c.text);
  assert.strictEqual((await row("ver-machine")).app_version, "4.6.71");
});

test("wired: the platform's machine list returns app_version (pg-mem can't run that route's ANY($1) lookup, so its SQL is checked)", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "index.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /SELECT machine_id, machine_name, os, activated_at, last_seen, station_uuid, app_version\n\s+FROM license_activations WHERE license_key = ANY\(\$1\)/);
  assert.strictEqual((src.match(/await recordAppVersion\(/g) || []).length, 8, "all seven device writes + the account check");
});

test("a request with no version leaves the recorded one alone; an existing row with none stays empty (never back-filled)", async () => {
  await h.pool.query(`INSERT INTO licenses (email, plan, license_key, key_prefix) VALUES ('old@device.test','station','ETH-STN-OLDV-0001','ETH-STN-OLDV')`);
  await h.pool.query(`INSERT INTO license_activations (license_key, machine_id, machine_name) VALUES ('ETH-STN-OLDV-0001','old-machine','Old PC')`);
  const c = await h.call("POST", "/account/connect", { headers: { "user-agent": "curl/8" }, body: { license_key: "ETH-STN-OLDV-0001", machine_id: "old-machine" } });
  assert.strictEqual(c.status, 200, c.text);
  assert.strictEqual((await row("old-machine")).app_version, null);
});

test("the account check never creates a device row (only updates an existing one)", async () => {
  await h.call("POST", "/account/connect", { headers: { "user-agent": UA("4.6.57") }, body: { license_key: "ETH-STN-OLDV-0001", machine_id: "never-seated" } });
  assert.strictEqual(await row("never-seated"), undefined);
});

test("the platform's machine list shows each machine's Ether version (and none for a machine that hasn't reported)", async () => {
  const licId = (await h.pool.query(`SELECT license_key_id FROM users WHERE email = 'ver@device.test'`)).rows[0].license_key_id;
  const m = await h.call("GET", `/api/platform/licenses/${licId}/machines`, { headers: { authorization: `Bearer ${platform}` } });
  assert.strictEqual(m.status, 200, m.text);
  assert.strictEqual(m.body.machines.length, 1);
  assert.strictEqual(m.body.machines[0].machine_name, "Studio PC");
  assert.strictEqual(m.body.machines[0].app_version, "4.6.71");
  const oldId = (await h.pool.query(`SELECT id FROM licenses WHERE license_key = 'ETH-STN-OLDV-0001'`)).rows[0].id;
  const o = await h.call("GET", `/api/platform/licenses/${oldId}/machines`, { headers: { authorization: `Bearer ${platform}` } });
  assert.strictEqual(o.body.machines[0].app_version, null);
});
