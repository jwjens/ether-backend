'use strict';
// Sign-in rate limit per visitor behind Railway's one proxy (trust proxy = 1): two addresses get separate limits, and a
// visitor cannot dodge the limit by sending their own X-Forwarded-For (the last entry, added by the proxy, is the one
// counted). The real server (test/server-harness.js); /api/user/login allows 40 tries per 15 minutes per address.
const test = require("node:test");
const assert = require("node:assert");
const { startServer } = require("./server-harness");

let h;
test.before(async () => { h = await startServer(); });
test.after(async () => { if (h) await h.close(); });
const login = (xff) => h.call("POST", "/api/user/login", { headers: { "x-forwarded-for": xff }, body: { email: "nobody@limit.test", password: "wrong-password-1" } });

test("two different addresses get separate sign-in limits; a forged first entry does not dodge it", async () => {
  const A = "203.0.113.10", B = "198.51.100.20";
  for (let i = 0; i < 40; i++) assert.notStrictEqual((await login(A)).status, 429, `try ${i + 1} from A is within the limit`);
  assert.strictEqual((await login(A)).status, 429, "the 41st try from A is refused");
  assert.notStrictEqual((await login(B)).status, 429, "B has its own limit");
  assert.strictEqual((await login(`192.0.2.99, ${A}`)).status, 429, "A sending a forged first address is still counted as A");
});

test("wired: trust proxy is one hop, set right after the app is made", () => {
  // line endings normalised: a Windows working copy can have CRLF
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "index.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /const app {4}= express\(\);\n(\/\/[^\n]*\n)+app\.set\("trust proxy", 1\);/);
});

test("device records use the same trusted address: a desktop sign-in sending a forged first address records the real one", async () => {
  const email = "device-ip@limit.test", password = "device-ip-pass-1";
  const real = "203.0.113.77";
  const su = await h.call("POST", "/api/user/signup", { headers: { "x-forwarded-for": real }, body: { name: "Device IP", email, password } });
  assert.ok(su.status === 200 || su.status === 201, su.text);
  const da = await h.call("POST", "/api/user/desktop-activate", { headers: { "x-forwarded-for": `192.0.2.66, ${real}` },
    body: { email, password, machine_id: "machine-ip-test", machine_name: "IP test" } });
  assert.strictEqual(da.status, 200, da.text);
  const row = (await h.pool.query(`SELECT ip_address FROM license_activations WHERE machine_id = 'machine-ip-test'`)).rows[0];
  assert.ok(row, "the device was recorded");
  assert.strictEqual(row.ip_address, real, "the address Railway added, not the forged first entry");
});

test("wired: no place reads the first X-Forwarded-For entry by hand any more; all five use clientIp(req)", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "index.js"), "utf8");
  assert.doesNotMatch(src, /x-forwarded-for"\]\?\.split/);
  assert.strictEqual((src.match(/const ip = clientIp\(req\);/g) || []).length, 5);
});
