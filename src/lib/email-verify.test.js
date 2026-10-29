'use strict';
// Email verification at sign-up (Jeff, 2026-10-29): "the confirmation link lasts 24 hours; an unverified person may start
// a trial on a brand-new license of their own, but can't claim or join anything that already exists until verified."
// Real SQL on pg-mem.
const test = require("node:test");
const assert = require("node:assert");
const { newDb } = require("pg-mem");
const EV = require("./email-verify");
const { resolveDesktopLicense } = require("./desktop-license");

const T0 = Date.parse("2026-10-29T12:00:00Z");
const HOUR = 3600 * 1000;

async function harness(sql = "") {
  const db = newDb();
  db.public.none(`
    CREATE TABLE licenses (id SERIAL PRIMARY KEY, email TEXT, plan TEXT, license_key TEXT, key_prefix TEXT, expires_at TIMESTAMPTZ, active BOOLEAN DEFAULT true);
    CREATE TABLE users (id INT PRIMARY KEY, email TEXT, license_key_id INT, email_verified BOOLEAN NOT NULL DEFAULT false,
      verify_token TEXT, trial_ends_at TIMESTAMPTZ);
    CREATE TABLE memberships (id SERIAL PRIMARY KEY, user_id INT, account_id INT, status TEXT DEFAULT 'active', deleted_at TIMESTAMPTZ);
    -- an existing account (license 100) and its verified owner
    INSERT INTO licenses (id, email, plan, license_key) VALUES (100, 'owner@example.org', 'station', 'ETH-STN-OWNER');
    INSERT INTO users (id, email, license_key_id, email_verified) VALUES (1, 'owner@example.org', 100, true);
    -- a person who just signed up (not verified), invited to license 100
    INSERT INTO users (id, email, trial_ends_at) VALUES (2, 'pd@example.org', '2026-11-13T00:00:00Z');
    INSERT INTO memberships (user_id, account_id) VALUES (2, 100);
  ` + sql);
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  for (const ddl of EV.VERIFY_DDL) await pool.query(ddl);
  return pool;
}
const user = async (pool, id) => (await pool.query(`SELECT * FROM users WHERE id = $1`, [id])).rows[0];
const countingMemberships = async (pool, uid) => (await pool.query(
  `SELECT m.account_id FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.user_id = $1 AND m.status = 'active' AND m.deleted_at IS NULL AND ${EV.MEMBERSHIP_COUNTS_SQL}`, [uid])).rows;

test("the link's token is never stored: only its SHA-256, with an expiry 24 hours out", async () => {
  const pool = await harness();
  const raw = await EV.issue(pool, 2, { now: T0 });
  const u = await user(pool, 2);
  assert.notEqual(u.verify_token, raw, "the raw token is in the database");
  assert.equal(u.verify_token, EV.hashToken(raw));
  assert.equal(new Date(u.verify_expires).getTime(), T0 + 24 * HOUR);
});

test("the link works once", async () => {
  const pool = await harness();
  const raw = await EV.issue(pool, 2, { now: T0 });
  assert.deepEqual(await EV.confirm(pool, raw, { now: T0 + HOUR }), { ok: true, userId: 2 });
  assert.equal((await user(pool, 2)).email_verified, true);
  assert.equal((await EV.confirm(pool, raw, { now: T0 + HOUR })).ok, false, "a used link works again");
});

test("the link lasts 24 hours, not a minute longer", async () => {
  const pool = await harness();
  const raw = await EV.issue(pool, 2, { now: T0 });
  assert.deepEqual(await EV.confirm(pool, raw, { now: T0 + 24 * HOUR + 60 * 1000 }), { ok: false, error: "expired" });
  assert.equal((await user(pool, 2)).email_verified, false);
  const raw2 = await EV.issue(pool, 2, { now: T0 });
  assert.equal((await EV.confirm(pool, raw2, { now: T0 + 24 * HOUR - 60 * 1000 })).ok, true, "a link inside 24 h is refused");
});

test("a new link replaces the old one; a made-up token and an empty one confirm nothing", async () => {
  const pool = await harness();
  const old = await EV.issue(pool, 2, { now: T0 });
  await EV.issue(pool, 2, { now: T0 });
  assert.equal((await EV.confirm(pool, old, { now: T0 })).error, "invalid_token");
  assert.equal((await EV.confirm(pool, "made-up", { now: T0 })).error, "invalid_token");
  assert.equal((await EV.confirm(pool, "", { now: T0 })).error, "missing_token");
  assert.equal((await user(pool, 2)).email_verified, false);
});

test("a link from before this change (stored as plain text, no expiry) no longer works", async () => {
  const pool = await harness(`UPDATE users SET verify_token = 'old-plain-token' WHERE id = 2;`);
  assert.equal((await EV.confirm(pool, "old-plain-token", { now: T0 })).ok, false);
});

test("a password reset proves the inbox: the email is confirmed and any open link is spent", async () => {
  const pool = await harness();
  const raw = await EV.issue(pool, 2, { now: T0 });
  await EV.markVerified(pool, 2);
  const u = await user(pool, 2);
  assert.equal(u.email_verified, true); assert.equal(u.verify_token, null);
  assert.equal((await EV.confirm(pool, raw, { now: T0 })).ok, false);
});

test("JOIN: an unverified person's invitation to an existing account does not count until they confirm", async () => {
  const pool = await harness();
  assert.deepEqual(await countingMemberships(pool, 2), [], "an unverified invitee is in the account");
  await EV.confirm(pool, await EV.issue(pool, 2), {});
  assert.deepEqual((await countingMemberships(pool, 2)).map(r => r.account_id), [100]);
});

test("a membership in the person's OWN license counts whether or not the email is verified", async () => {
  const pool = await harness(`
    INSERT INTO licenses (id, email, plan, license_key) VALUES (200, 'solo@example.org', 'station', 'ETH-STN-SOLO');
    INSERT INTO users (id, email, license_key_id) VALUES (3, 'solo@example.org', 200);
    INSERT INTO memberships (user_id, account_id) VALUES (3, 200);`);
  assert.deepEqual((await countingMemberships(pool, 3)).map(r => r.account_id), [200]);
});

test("CLAIM: an unverified invitee's desktop gets a brand-new trial of their own, never the existing account", async () => {
  const pool = await harness();
  const pick = await resolveDesktopLicense(pool, await user(pool, 2), { generateLicenseKey: () => "ETH-STN-NEWTRIAL" });
  assert.equal(pick.via, "new");
  assert.notEqual(pick.license.id, 100);
  assert.equal(pick.license.license_key, "ETH-STN-NEWTRIAL");
  await EV.markVerified(pool, 2);
  // verified now; the trial they started is their own license, which comes first
  const again = await resolveDesktopLicense(pool, await user(pool, 2), { generateLicenseKey: () => "unused" });
  assert.equal(again.license.id, pick.license.id);
});

test("CLAIM: once verified, an invitee with no license of their own activates on the account they were invited to", async () => {
  const pool = await harness(`UPDATE users SET email_verified = true WHERE id = 2;`);
  const pick = await resolveDesktopLicense(pool, await user(pool, 2), { generateLicenseKey: () => "unused" });
  assert.equal(pick.via, "member"); assert.equal(pick.license.id, 100);
});
