'use strict';
// GET /public/plans through the real server: the catalog every screen reads prices from.
const test = require("node:test");
const assert = require("node:assert");
const { startServer } = require("./server-harness");

let h;
test.before(async () => { h = await startServer(); });
test.after(async () => { if (h) await h.close(); });

test("GET /public/plans: no sign-in needed; Local, Station, Pro, Unlimited and no free plan", async () => {
  const r = await h.call("GET", "/public/plans");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.body.plans), ["local", "station", "pro", "unlimited"]);
  assert.equal(r.body.plans.local.price_monthly, 9);
  assert.equal(r.body.trial.days, 15);
  assert.ok(!/PRICE_|price_[A-Za-z0-9]{8,}/.test(r.text), "Stripe variable names or ids leaked");
  assert.equal(typeof r.body.purchasable.local_monthly, "boolean");
});
