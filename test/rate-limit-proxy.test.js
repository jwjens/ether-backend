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
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "index.js"), "utf8");
  assert.match(src, /const app {4}= express\(\);\n(\/\/[^\n]*\n)+app\.set\("trust proxy", 1\);/);
});
