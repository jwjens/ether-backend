'use strict';
// The local billing test server (scripts/billing-test-server.js) refuses live Stripe keys before anything starts, and
// its seeded states each show their notice.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseEnvFile, refuseLiveKeys, accounts } = require("../scripts/billing-test-server");
const { billingNotice } = require("../src/lib/billing-notice");
const catalog = require("../src/lib/plans").load();

const SCRIPT = path.join(__dirname, "..", "scripts", "billing-test-server.js");

test("parses the test env file (comments, quotes)", () => {
  assert.deepEqual(parseEnvFile("# c\nSTRIPE_SECRET_KEY=sk_test_1\nSTRIPE_WEBHOOK_SECRET=\"whsec_2\"\n\nbad line"),
    { STRIPE_SECRET_KEY: "sk_test_1", STRIPE_WEBHOOK_SECRET: "whsec_2" });
});

test("refuses sk_live / rk_live / pk_live and any non-test secret key; accepts test keys and no keys", () => {
  assert.throws(() => refuseLiveKeys({ STRIPE_SECRET_KEY: "sk_live_abc" }), /REFUSED: STRIPE_SECRET_KEY is a LIVE/);
  assert.throws(() => refuseLiveKeys({ STRIPE_SECRET_KEY: "sk_test_ok", OTHER: "rk_live_x" }), /LIVE/);
  assert.throws(() => refuseLiveKeys({ PK: "pk_live_x" }), /LIVE/);
  assert.throws(() => refuseLiveKeys({ STRIPE_SECRET_KEY: "something" }), /not a test key/);
  refuseLiveKeys({ STRIPE_SECRET_KEY: "sk_test_ok", STRIPE_WEBHOOK_SECRET: "whsec_x" });
  refuseLiveKeys({});
});

test("run with a live key in .env.billing-test: exits non-zero, says REFUSED, starts nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bts-"));
  const file = path.join(dir, ".env.billing-test");
  fs.writeFileSync(file, "STRIPE_SECRET_KEY=sk_live_notreal\n");
  const r = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, BILLING_TEST_ENV_FILE: file, BILLING_TEST_PORT: "0" }, encoding: "utf8", timeout: 30000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /REFUSED/);
  assert.doesNotMatch(r.stdout, /BILLING TEST SERVER/);
});

test("run with a live key in the shell: refused too", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, BILLING_TEST_ENV_FILE: path.join(os.tmpdir(), "no-such-file"), STRIPE_SECRET_KEY: "sk_live_shell", BILLING_TEST_PORT: "0" }, encoding: "utf8", timeout: 30000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /REFUSED/);
});

test("each seeded TEST account shows its notice (and paid OK none)", () => {
  for (const a of accounts()) {
    const lic = { id: 1000, plan: "station", active: true, ...a.lic, ...(a.stripe ? { stripe_subscription_id: "sub_t", stripe_customer_id: "cus_t" } : {}) };
    const n = billingNotice({ license: lic, catalog, exemptIds: new Set() });
    assert.equal(n ? n.kind : null, a.expect, a.name);
    assert.match(a.name, /^TEST /);
  }
});
