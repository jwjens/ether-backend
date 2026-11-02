'use strict';
// The dashboard sign-in throttle's rules (src/lib/dashboard-throttle.js): per device / address, 5 wrong → 15 minutes.
const test = require("node:test");
const assert = require("node:assert");
const T = require("./dashboard-throttle");

const now = Date.parse("2026-11-02T10:00:00Z");
test("the numbers are today's lockout numbers: 5 wrong tries → 15 minutes", () => {
  assert.deepStrictEqual(T.DASHBOARD_THROTTLE, { maxFails: 5, minutes: 15 });
});
test("keys: the address always; the device only when it sent a usable id", () => {
  assert.deepStrictEqual(T.throttleKeys("1.2.3.4", "abcdef0123456789"), ["ip:1.2.3.4", "dev:abcdef0123456789"]);
  assert.deepStrictEqual(T.throttleKeys("1.2.3.4", "x"), ["ip:1.2.3.4"], "too short");
  assert.deepStrictEqual(T.throttleKeys("1.2.3.4", "<script>alert(1)</script>"), ["ip:1.2.3.4"], "odd characters");
  assert.deepStrictEqual(T.throttleKeys("", ""), []);
});
test("counting: 4 failures wait for nothing; the 5th blocks for 15 minutes and starts a fresh count", () => {
  let row = null;
  for (let i = 1; i <= 4; i++) { row = T.afterFailure(row, now + i * 1000); assert.strictEqual(row.failures, i); assert.strictEqual(T.blockedUntil([row], now + i * 1000), null); }
  row = T.afterFailure(row, now + 5000);
  assert.strictEqual(row.failures, 0);
  assert.strictEqual(T.blockedUntil([row], now + 5000).toISOString(), new Date(now + 5000 + 15 * 60000).toISOString());
  assert.strictEqual(T.blockedUntil([row], now + 5000 + 15 * 60000), null, "free again after 15 minutes");
});
test("failures older than the window don't add up", () => {
  let row = T.afterFailure(null, now);
  for (let i = 0; i < 3; i++) row = T.afterFailure(row, now + 1000);
  row = T.afterFailure(row, now + 16 * 60000);
  assert.strictEqual(row.failures, 1);
});
test("blockedUntil: the latest of the rows, ignoring past blocks", () => {
  const a = { blocked_until: new Date(now + 60000) }, b = { blocked_until: new Date(now + 120000) }, c = { blocked_until: new Date(now - 1) };
  assert.strictEqual(T.blockedUntil([a, b, c, null], now).getTime(), now + 120000);
  assert.strictEqual(T.blockedUntil([c, null], now), null);
});
