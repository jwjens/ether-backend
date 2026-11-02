'use strict';
// The thank-you email through the real server: a signed checkout.session.completed for an account → one email with the
// plan, both download links, how to start and the account site. (test/server-harness.js; email recorded, never sent.)
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { startServer } = require("./server-harness");

let h;
// a test-only signing secret (this file's process only); no Stripe key, so nothing here reaches Stripe
process.env.STRIPE_WEBHOOK_SECRET = "whsec_harness_purchase_email_test";
test.before(async () => { h = await startServer(); });
test.after(async () => { if (h) await h.close(); });

test("an account checkout sends one 'Welcome to Ether <plan>' email with downloads, how to start and the account link", async () => {
  const uid = (await h.pool.query(`INSERT INTO users (email, password_hash, email_verified) VALUES ('buyer@mail.test','x',true) RETURNING id`)).rows[0].id;
  const event = { id: "evt_t1", type: "checkout.session.completed", data: { object: {
    object: "checkout.session", mode: "subscription", client_reference_id: String(uid), customer_email: "buyer@mail.test",
    metadata: { user_id: String(uid), plan: "pro", period: "annual" }, subscription: "sub_mail_1", customer: "cus_mail_1" } } };
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${payload}`).digest("hex");
  const before = h.emails.length;
  const r = await fetch(`${h.base}/webhook/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` }, body: payload });
  assert.strictEqual(r.status, 200, await r.text());
  const mails = h.emails.slice(before);
  assert.strictEqual(mails.length, 1);
  const m = mails[0];
  assert.strictEqual(m.to, "buyer@mail.test");
  assert.strictEqual(m.subject, "Welcome to Ether Live 320");
  assert.match(m.html, /\$490\/year, billed yearly/);
  assert.match(m.html, /\/download\/mac"[^>]*>Download for Mac</);
  assert.match(m.html, /\/download\/windows"[^>]*>Download for Windows</);
  assert.match(m.html, /install Ether, then sign in with the same email and password/);
  assert.match(m.html, />Open your account</);
  if (process.env.WRITE_EMAIL_HTML) fs.writeFileSync(process.env.WRITE_EMAIL_HTML, m.html);
});
