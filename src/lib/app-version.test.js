'use strict';
// Which Ether version a request came from (src/lib/app-version.js).
const test = require("node:test");
const assert = require("node:assert");
const { appVersionOf } = require("./app-version");
const ua = (token) => ({ headers: { "user-agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ${token} Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36` } });

test("old builds: the app's token in the Electron User-Agent (either packaged name)", () => {
  assert.strictEqual(appVersionOf(ua("Ether/4.6.57")), "4.6.57");
  assert.strictEqual(appVersionOf(ua("openair/4.6.57")), "4.6.57");
  assert.strictEqual(appVersionOf({ headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Ether/4.6.70-beta.2 Chrome/130 Electron/33.4.11 Safari/537.36" } }), "4.6.70-beta.2");
});

test("Electron's own version and a browser's User-Agent are never taken", () => {
  assert.strictEqual(appVersionOf({ headers: { "user-agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/130 Electron/33.4.11 Safari/537.36" } }), null);
  assert.strictEqual(appVersionOf({ headers: { "user-agent": "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" } }), null);
  assert.strictEqual(appVersionOf({ headers: {} }), null);
  assert.strictEqual(appVersionOf(null), null);
});

test("new builds: an explicit app_version wins, then the x-ether-version header; junk is ignored", () => {
  assert.strictEqual(appVersionOf({ body: { app_version: "4.6.71" }, ...ua("Ether/4.6.57") }), "4.6.71");
  assert.strictEqual(appVersionOf({ headers: { "x-ether-version": "4.6.72", "user-agent": "x Ether/4.6.57 y" } }), "4.6.72");
  assert.strictEqual(appVersionOf({ body: { app_version: "<script>" }, ...ua("Ether/4.6.57") }), "4.6.57", "junk body falls back to the User-Agent");
  assert.strictEqual(appVersionOf({ body: { app_version: "1".repeat(200) } , headers: {} }), null);
});
