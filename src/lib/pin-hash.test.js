// src/lib/pin-hash.test.js — the backend reads PINs the desktop writes, in every format, and writes scrypt.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const P = require("./pin-hash");

test("new PINs are scrypt and verify", async () => {
  const h = await P.hashPin("4821");
  assert.ok(h.startsWith("scrypt$32768$8$1$"));
  assert.strictEqual((await P.verifyPin("4821", h)).ok, true);
  assert.strictEqual((await P.verifyPin("4822", h)).ok, false);
});
test("old desktop salt:sha256 PINs (install-pushed before 2026-10-20) still verify", async () => {
  const salt = crypto.randomBytes(16).toString("hex");
  const old = salt + ":" + crypto.createHash("sha256").update(salt + "1357").digest("hex");
  assert.strictEqual((await P.verifyPin("1357", old)).ok, true);
  assert.strictEqual((await P.verifyPin("1358", old)).ok, false);
});
const DESKTOP = require("path").join(__dirname, "..", "..", "..", "openair", "electron", "pin-hash.js");
test("a scrypt PIN made by the desktop module verifies here (identical modules)", { skip: !require("fs").existsSync(DESKTOP) && "desktop repo not beside this one" }, async () => {
  const D = require(DESKTOP);
  const h = await D.hashPin("2468");
  assert.strictEqual((await P.verifyPin("2468", h)).ok, true);
});
