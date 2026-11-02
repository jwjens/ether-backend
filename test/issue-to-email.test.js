'use strict';
// A license issued to an email, through the real server (test/server-harness.js; email recorded, never sent): the
// platform's preview and Issue for every case, the emails (no key), and the automatic link when the email is confirmed
// (through the real confirm link) and at desktop sign-in.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { startServer } = require("./server-harness");

let h, platform, n = 0;
test.before(async () => {
  h = await startServer();
  const t = (await h.pool.query(`SELECT COUNT(*)::int n FROM seat_tiers WHERE is_default = true`)).rows[0].n;
  if (!t) await h.pool.query(`INSERT INTO seat_tiers (name, seat_limit, is_default) VALUES ('Test default', NULL, true)`);
  platform = (await h.call("POST", "/api/platform/login", { body: { secret: h.secrets.ETHER_PLATFORM_SECRET } })).body.token;
});
test.after(async () => { if (h) await h.close(); });
const P = { authorization: () => `Bearer ${platform}` };
const asPlatform = (body) => ({ headers: { authorization: P.authorization() }, body });
const xff = () => ({ "x-forwarded-for": `203.0.113.${++n}` });
const preview = (email, plan) => h.call("POST", "/api/platform/licenses/preview", asPlatform({ email, plan }));
const issue = (email, plan) => h.call("POST", "/api/platform/licenses", asPlatform({ email, plan, send_email: true }));
const lastMailTo = (to) => [...h.emails].reverse().find((m) => m.to === to);
async function signup(email) {
  const r = await h.call("POST", "/api/user/signup", { headers: xff(), body: { name: "Issued", email, password: "issued-pass-1" } });
  assert.ok(r.status === 200 || r.status === 201, r.text);
  return r.body.token;
}
async function confirmByLink(email) {
  const m = lastMailTo(email);
  const token = /verify\?token=([A-Za-z0-9_-]+)/.exec(m.html)[1];
  const r = await h.call("POST", "/api/user/verify", { headers: xff(), body: { token } });
  assert.strictEqual(r.status, 200, r.text);
}
const userRow = async (email) => (await h.pool.query(`SELECT * FROM users WHERE lower(email) = $1`, [email])).rows[0];
const licRow = async (id) => (await h.pool.query(`SELECT * FROM licenses WHERE id = $1`, [id])).rows[0];

test("no account yet: preview 'create'; Issue makes the license and emails Jeff's words with NO key; it links when they sign up and confirm", async () => {
  const email = "newbie@issue.test";
  const p = await preview(email, "unlimited");
  assert.strictEqual(p.status, 200); assert.strictEqual(p.body.action, "create"); assert.strictEqual(p.body.to_label, "Network");
  const r = await issue(email, "unlimited");
  assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.body.action, "create");
  const m = lastMailTo(email);
  assert.strictEqual(m.subject, "Your Ether license is ready");
  assert.match(m.html, /Your Ether license is ready\./);
  assert.match(m.html, /Create your account at <a href="[^"]+"[^>]*>[^<]+<\/a> with this email address, confirm it, then install Ether and sign in\./);
  assert.ok(!m.html.includes(r.body.license_key) && !/license key/i.test(m.html), "no key in the email");
  if (process.env.WRITE_NEW_EMAIL_HTML) fs.writeFileSync(process.env.WRITE_NEW_EMAIL_HTML, m.html);
  const token = await signup(email);
  assert.strictEqual((await userRow(email)).license_key_id, null, "not linked while the email is unconfirmed");
  const me0 = await h.call("GET", "/api/user/me", { headers: { authorization: `Bearer ${token}` } });
  assert.strictEqual(me0.status, 200); assert.notStrictEqual(me0.body.account.entitlement.plan, "unlimited");
  await confirmByLink(email);
  assert.strictEqual((await userRow(email)).license_key_id, r.body.id, "linked on confirm");
  const me = await h.call("GET", "/api/user/me", { headers: { authorization: `Bearer ${token}` } });
  assert.strictEqual(me.body.account.entitlement.plan, "unlimited");
});

test("account confirmed, no license: preview 'create_and_link'; Issue links now; the email says their account is on the plan", async () => {
  const email = "ready@issue.test";
  await signup(email); await confirmByLink(email);
  const p = await preview(email, "station");
  assert.strictEqual(p.body.action, "create_and_link");
  const r = await issue(email, "station");
  assert.strictEqual(r.body.action, "create_and_link");
  assert.strictEqual((await userRow(email)).license_key_id, r.body.id);
  const m = lastMailTo(email);
  assert.strictEqual(m.subject, "Your Ether account is now on Live 128");
  assert.match(m.html, /Your Ether account is now on the <strong[^>]*>Live 128<\/strong> plan\. Open Ether and sign in with this email address\./);
  assert.ok(!/license key/i.test(m.html));
  if (process.env.WRITE_EXISTING_EMAIL_HTML) fs.writeFileSync(process.env.WRITE_EXISTING_EMAIL_HTML, m.html);
});

test("account on a trial: preview names the license and the change; Issue changes THAT license (plan, no end date) — no second license", async () => {
  const email = "trialist@issue.test";
  await signup(email); await confirmByLink(email);
  const da = await h.call("POST", "/api/user/desktop-activate", { headers: xff(), body: { email, password: "issued-pass-1", machine_id: "m-trial", machine_name: "PC" } });
  assert.strictEqual(da.status, 200, da.text);
  const licId = (await userRow(email)).license_key_id;
  const before = await licRow(licId);
  assert.ok(before.expires_at, "a trial");
  const p = await preview(email, "pro");
  assert.strictEqual(p.body.action, "upgrade");
  assert.deepStrictEqual([p.body.license.id, p.body.license.email, p.body.from_label, p.body.to_label], [licId, email, "Live 128", "Live 320"]);
  const count0 = (await h.pool.query(`SELECT COUNT(*)::int n FROM licenses`)).rows[0].n;
  const r = await issue(email, "pro");
  assert.strictEqual(r.body.action, "upgrade"); assert.strictEqual(r.body.id, licId);
  assert.strictEqual((await h.pool.query(`SELECT COUNT(*)::int n FROM licenses`)).rows[0].n, count0, "no second license");
  const after = await licRow(licId);
  assert.strictEqual(after.plan, "pro"); assert.strictEqual(after.expires_at, null);
  assert.strictEqual(after.license_key, before.license_key, "same license, same key");
});

test("a paid Stripe subscription or a lifetime license: preview and Issue refuse with the message; nothing changes", async () => {
  await h.pool.query(`INSERT INTO licenses (email, plan, license_key, key_prefix, stripe_subscription_id) VALUES ('payer@issue.test', 'station', 'ETH-STN-PAYR-0001', 'ETH-STN-PAYR', 'sub_paid')`);
  await h.pool.query(`INSERT INTO licenses (email, plan, license_key, key_prefix) VALUES ('forever@issue.test', 'station_lifetime', 'ETH-STN-LIFE-0001', 'ETH-STN-LIFE')`);
  for (const [email, lk, msg] of [["payer@issue.test", "ETH-STN-PAYR-0001", "This account has a paid subscription; change it in Stripe first."],
                                  ["forever@issue.test", "ETH-STN-LIFE-0001", "This account has a lifetime license; it isn't changed."]]) {
    const id = (await h.pool.query(`SELECT id FROM licenses WHERE license_key = $1`, [lk])).rows[0].id;
    await h.pool.query(`INSERT INTO users (email, email_verified, license_key_id, password_hash) VALUES ($1, true, $2, 'x')`, [email, id]);
    const before = JSON.stringify(await licRow(id));
    const p = await preview(email, "unlimited");
    assert.strictEqual(p.body.action, "refuse"); assert.strictEqual(p.body.message, msg);
    const r = await issue(email, "unlimited");
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.message, msg);
    assert.strictEqual(JSON.stringify(await licRow(id)), before);
  }
});

test("issued before the account existed, confirmed without the link page: the license links at desktop sign-in", async () => {
  const email = "later@issue.test";
  const r = await issue(email, "unlimited");
  await signup(email);
  await h.pool.query(`UPDATE users SET email_verified = true WHERE lower(email) = $1`, [email]);
  const da = await h.call("POST", "/api/user/desktop-activate", { headers: xff(), body: { email, password: "issued-pass-1", machine_id: "m-later", machine_name: "PC" } });
  assert.strictEqual(da.status, 200, da.text);
  assert.strictEqual((await userRow(email)).license_key_id, r.body.id);
  assert.strictEqual(da.body.plan, "unlimited");
});
