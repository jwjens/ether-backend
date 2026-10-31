'use strict';
// Billing emails through the real server's own sender (test/server-harness.js: emails recorded, never sent):
// once per kind per period, a failed send retried, exempt/lifetime never, stale states not emailed, and the hourly job
// only with BILLING_EMAILS=1.
const test = require("node:test");
const assert = require("node:assert");
const { startServer } = require("./server-harness");
const { billingEmailsOn } = require("../src/lib/billing-emails");

const DAY = 86400000;
const at = (d) => new Date(Date.now() + d * DAY).toISOString();
let h, srv;
test.before(async () => { h = await startServer(); srv = require("../src/index.js"); });
test.after(async () => { if (h) await h.close(); });

async function lic(email, cols) {
  const all = { email, license_key: `ETH-STN-EM-${email}`, plan: "station", active: true, ...cols };
  const k = Object.keys(all);
  return (await h.pool.query(`INSERT INTO licenses (${k.join(",")}) VALUES (${k.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`, k.map(x => all[x]))).rows[0].id;
}

test("one email per kind per period; a second pass sends nothing", async () => {
  await lic("ending@billing.test", { expires_at: at(2) });
  await lic("declined@billing.test", { stripe_subscription_id: "sub_d", stripe_customer_id: "cus_d", payment_failed_at: at(-1) });
  await lic("life@billing.test", { plan: "station_lifetime", expires_at: at(-3), payment_failed_at: at(-1) });
  await lic("fine@billing.test", { stripe_subscription_id: "sub_f" });
  await lic("stale@billing.test", { expires_at: at(-200) });   // lapsed long ago: banner yes, email no (fresh only)
  h.emails.length = 0;
  const first = await srv.runBillingEmails();
  const got = h.emails.map(e => [e.to, e.subject]).sort();
  assert.deepEqual(got, [
    ["declined@billing.test", "Ether: Your payment didn't go through"],
    ["ending@billing.test", "Ether: Your free trial ends in 2 days"],
  ]);
  assert.equal(first.sent.length, 2);
  assert.match(h.emails[0].html, /keeps playing/);
  const second = await srv.runBillingEmails();
  assert.equal(second.sent.length, 0);
  assert.equal(h.emails.length, 2, "nothing more sent");
  const rows = (await h.pool.query(`SELECT kind FROM billing_notices_sent ORDER BY kind`)).rows.map(r => r.kind);
  assert.deepEqual(rows, ["payment_failed", "trial_ending"]);
});

test("a new period (a later payment failure) is a new email", async () => {
  await h.pool.query(`UPDATE licenses SET payment_failed_at = $1 WHERE email = 'declined@billing.test'`, [at(0)]);
  h.emails.length = 0;
  const r = await srv.runBillingEmails();
  assert.deepEqual(r.sent.map(s => s.to), ["declined@billing.test"]);
});

test("a failed send gives the claim back, so the next pass retries", async () => {
  await lic("retry@billing.test", { expires_at: at(-1) });
  const real = srv.resend.emails.send;
  srv.resend.emails.send = async () => ({ data: null, error: { message: "resend down" } });
  try {
    const r = await srv.runBillingEmails();
    assert.equal(r.failed, 1);
    assert.equal((await h.pool.query(`SELECT COUNT(*)::int n FROM billing_notices_sent WHERE kind = 'trial_ended'`)).rows[0].n, 0);
  } finally { srv.resend.emails.send = real; }
  h.emails.length = 0;
  const again = await srv.runBillingEmails();
  assert.deepEqual(again.sent.map(s => [s.to, s.kind]), [["retry@billing.test", "trial_ended"]]);
});

test("an account with no license yet: its users-row trial, keyed by user", async () => {
  const s = await h.call("POST", "/api/user/signup", { body: { email: "nolic@billing.test", password: "password-1" } });
  assert.equal(s.status, 200, s.text);
  await h.pool.query(`UPDATE users SET trial_ends_at = $1 WHERE email = 'nolic@billing.test'`, [at(1)]);
  h.emails.length = 0;
  const r = await srv.runBillingEmails();
  assert.deepEqual(r.sent.map(x => [x.to, x.kind, x.license_id]), [["nolic@billing.test", "trial_ending", 0]]);
  assert.match(r.sent[0].period_key, /^user:\d+:/);
});

test("the hourly job runs only with BILLING_EMAILS=1", () => {
  assert.equal(billingEmailsOn({}), false);
  assert.equal(billingEmailsOn({ BILLING_EMAILS: "0" }), false);
  assert.equal(billingEmailsOn({ BILLING_EMAILS: "true" }), false);
  assert.equal(billingEmailsOn({ BILLING_EMAILS: "1" }), true);
  const src = require("node:fs").readFileSync(require.resolve("../src/index.js"), "utf8");
  assert.match(src, /if \(BILLING_EMAILS\.billingEmailsOn\(\)\) \{/);
});
