'use strict';
// Step a (docs/link-access-audit-and-email-2026-10-28.md §4.1): the server loads in a test without changing what it does.
// The real src/index.js, real boot schema, real routes, on pg-mem.
const test = require("node:test");
const assert = require("node:assert");
const { startServer } = require("./server-harness");

let h;
test.before(async () => { h = await startServer(); });
test.after(async () => { if (h) await h.close(); });

test("the real boot schema runs (initDB) and the server answers /health", async () => {
  const r = await h.call("GET", "/health");
  assert.equal(r.status, 200);
  const t = (await h.pool.query(`SELECT COUNT(*)::int n FROM positions WHERE account_id IS NULL`)).rows[0].n;
  assert.equal(t, 6, "the six system positions are seeded");
});

// (A second initDB — a restart — cannot be tested here: pg-mem refuses CREATE TABLE IF NOT EXISTS on a table that
// already exists. Production restarts on every deploy.)

test("loaded by a test, the server does not listen on its own port or start its timers", async () => {
  // start() runs only when index.js is the program (require.main === module): node src/index.js, the Procfile.
  const src = require("node:fs").readFileSync(require.resolve("../src/index.js"), "utf8");
  assert.match(src, /\r?\nif \(require\.main === module\) start\(\);\r?\n/);
  assert.equal((src.match(/app\.listen\(/g) || []).length, 1, "one listen, inside start()");
});

test("sign-up through the real route: signed in at once, and a 24-hour link emailed (never sent from a test)", async () => {
  const r = await h.call("POST", "/api/user/signup", { body: { email: "new@example.org", password: "password-1" } });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.body.token, "sign-up signs the person in");
  assert.equal(r.body.account.email_verified, false);
  assert.equal(h.emails.length, 1);
  const link = /verify\?token=([A-Za-z0-9_-]+)/.exec(h.emails[0].html)[1];
  const u = (await h.pool.query(`SELECT verify_token, verify_expires FROM users WHERE email = 'new@example.org'`)).rows[0];
  assert.notEqual(u.verify_token, link, "the link's token is stored as-is");
  assert.ok(new Date(u.verify_expires) - Date.now() > 23.9 * 3600 * 1000);
  const v = await h.call("POST", "/api/user/verify", { body: { token: link } });
  assert.equal(v.status, 200, v.text);
  assert.equal((await h.call("POST", "/api/user/verify", { body: { token: link } })).status, 400, "the link works twice");
  const me = await h.call("GET", "/api/user/me", { headers: { authorization: `Bearer ${r.body.token}` } });
  assert.equal(me.body.account.email_verified, true);
});

test("an expired link says so, and 'Send a new link' from that link (not signed in) mails a fresh 24-hour link to the account's own address", async () => {
  const r = await h.call("POST", "/api/user/signup", { body: { email: "late@example.org", password: "password-1" } });
  assert.equal(r.status, 200, r.text);
  const sent = h.emails.length;
  const old = /verify\?token=([A-Za-z0-9_-]+)/.exec(h.emails[sent - 1].html)[1];
  await h.pool.query(`UPDATE users SET verify_expires = now() - interval '1 hour' WHERE email = 'late@example.org'`);
  const v = await h.call("POST", "/api/user/verify", { body: { token: old } });
  assert.equal(v.status, 400); assert.equal(v.body.error, "expired", "an expired link is told apart from a wrong one");

  const n = await h.call("POST", "/api/user/verify/resend", { body: { token: old } });   // no Authorization header
  assert.equal(n.status, 200, n.text);
  assert.equal(h.emails.length, sent + 1, "one new email");
  assert.deepEqual([].concat(h.emails[sent].to), ["late@example.org"], "sent only to the account's own address");
  const fresh = /verify\?token=([A-Za-z0-9_-]+)/.exec(h.emails[sent].html)[1];
  assert.notEqual(fresh, old);
  assert.equal((await h.call("POST", "/api/user/verify", { body: { token: old } })).body.error, "invalid_token", "the old link stops working");
  assert.equal((await h.call("POST", "/api/user/verify", { body: { token: fresh } })).status, 200, "the new link confirms");
  assert.equal((await h.call("POST", "/api/user/verify/resend", { body: { token: fresh } })).status, 400, "a spent link can't send another");
});

test("'Send a new link' with a made-up link sends nothing; without a link it still needs a sign-in", async () => {
  const sent = h.emails.length;
  const bad = await h.call("POST", "/api/user/verify/resend", { body: { token: "not-a-real-link" } });
  assert.equal(bad.status, 400); assert.equal(bad.body.error, "invalid_token");
  assert.equal((await h.call("POST", "/api/user/verify/resend", { body: {} })).status, 401);
  assert.equal(h.emails.length, sent, "nothing sent");
});
