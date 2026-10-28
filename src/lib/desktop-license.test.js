'use strict';
// Which license a signed-in user's desktop activates on (POST /api/user/desktop-activate) — Jeff, 2026-10-28: "never
// hand a license to someone by email match. A license is claimed only with its key or by a verified, invited member."
// docs/link-access-audit-and-email-2026-10-28.md §2 row 1. Real SQL on pg-mem.
const test = require("node:test");
const assert = require("node:assert");
const { newDb } = require("pg-mem");
const R = require("./desktop-license");
const resolveDesktopLicense = async (...a) => { const r = await R.resolveDesktopLicense(...a); return r && r.license; };

let n = 0;
const gen = () => `ETH-STN-NEW-${++n}`;

async function harness(sql) {
  const db = newDb();
  db.public.none(`
    CREATE TABLE licenses (id SERIAL PRIMARY KEY, email TEXT, plan TEXT, license_key TEXT, key_prefix TEXT, expires_at TIMESTAMPTZ, active BOOLEAN DEFAULT true);
    CREATE TABLE users (id INT PRIMARY KEY, email TEXT, license_key_id INT, email_verified BOOLEAN DEFAULT false, trial_ends_at TIMESTAMPTZ);
    CREATE TABLE memberships (id SERIAL PRIMARY KEY, user_id INT, account_id INT, status TEXT DEFAULT 'active', deleted_at TIMESTAMPTZ);
    -- a trial customer: their own trial license, issued to their email, and their login
    INSERT INTO licenses (id, email, plan, license_key, expires_at) VALUES (100, 'customer@example.org', 'station', 'ETH-STN-CUSTOMER', '2026-11-10T00:00:00Z');
    INSERT INTO users (id, email, license_key_id, email_verified) VALUES (1, 'customer@example.org', 100, true);
    ` + (sql || ""));
  const { Pool } = db.adapters.createPg();
  return { pool: new Pool(), db };
}
const userRow = async (pool, id) => (await pool.query(`SELECT * FROM users WHERE id = $1`, [id])).rows[0];

test("STRANGER: someone who signs up with a trial customer's email never gets that customer's license", async () => {
  // The customer's login has since been unlinked (license_key_id cleared — e.g. by the platform's "remove email"), and
  // a stranger has a login with the same email, unverified, no license of their own.
  const { pool } = await harness(`
    UPDATE users SET license_key_id = NULL WHERE id = 1;
    INSERT INTO users (id, email, license_key_id, email_verified, trial_ends_at) VALUES (2, 'Customer@Example.org ', NULL, false, '2026-11-12T00:00:00Z');`);
  const lic = await resolveDesktopLicense(pool, await userRow(pool, 2), { generateLicenseKey: gen });
  assert.notEqual(lic.id, 100, "handed the customer's license by email match");
  assert.notEqual(lic.license_key, "ETH-STN-CUSTOMER");
  assert.notEqual((await userRow(pool, 2)).license_key_id, 100, "linked to the customer's license");
});

test("a user's own license (claimed with its key, or issued to them) is theirs", async () => {
  const { pool } = await harness("");
  const lic = await resolveDesktopLicense(pool, await userRow(pool, 1), { generateLicenseKey: gen });
  assert.equal(lic.id, 100);
});

test("no license of your own: a BRAND-NEW trial license, never an existing one", async () => {
  const { pool } = await harness(`INSERT INTO users (id, email, license_key_id, trial_ends_at) VALUES (3, 'new@example.org', NULL, '2026-11-12T00:00:00Z');`);
  const before = (await pool.query(`SELECT COUNT(*)::int c FROM licenses`)).rows[0].c;
  const lic = await resolveDesktopLicense(pool, await userRow(pool, 3), { generateLicenseKey: gen });
  assert.equal((await pool.query(`SELECT COUNT(*)::int c FROM licenses`)).rows[0].c, before + 1, "a new license");
  assert.equal(lic.email, "new@example.org"); assert.ok(lic.expires_at, "a trial");
  assert.equal((await userRow(pool, 3)).license_key_id, lic.id);
});

test("an invited member whose email is VERIFIED activates on the account they were invited to", async () => {
  const { pool } = await harness(`
    INSERT INTO users (id, email, license_key_id, email_verified) VALUES (4, 'pd@example.org', NULL, true);
    INSERT INTO memberships (user_id, account_id) VALUES (4, 100);`);
  const lic = await resolveDesktopLicense(pool, await userRow(pool, 4), { generateLicenseKey: gen });
  assert.equal(lic.id, 100);
});

test("an invited member whose email is NOT verified cannot join it (they get a new trial of their own)", async () => {
  const { pool } = await harness(`
    INSERT INTO users (id, email, license_key_id, email_verified, trial_ends_at) VALUES (5, 'pd2@example.org', NULL, false, '2026-11-12T00:00:00Z');
    INSERT INTO memberships (user_id, account_id) VALUES (5, 100);`);
  const lic = await resolveDesktopLicense(pool, await userRow(pool, 5), { generateLicenseKey: gen });
  assert.notEqual(lic.id, 100);
});

test("a removed membership grants nothing", async () => {
  const { pool } = await harness(`
    INSERT INTO users (id, email, license_key_id, email_verified, trial_ends_at) VALUES (6, 'gone@example.org', NULL, true, '2026-11-12T00:00:00Z');
    INSERT INTO memberships (user_id, account_id, deleted_at) VALUES (6, 100, '2026-10-01T00:00:00Z');`);
  const lic = await resolveDesktopLicense(pool, await userRow(pool, 6), { generateLicenseKey: gen });
  assert.notEqual(lic.id, 100);
});

test("the route's gate stays: no current trial and no license of your own → nothing (not a new trial)", async () => {
  const { pool } = await harness(`INSERT INTO users (id, email, license_key_id, trial_ends_at) VALUES (7, 'late@example.org', NULL, '2026-01-01T00:00:00Z');`);
  const r = await R.resolveDesktopLicense(pool, await userRow(pool, 7), { generateLicenseKey: gen, entitled: false });
  assert.equal(r, null);
});

test("a verified invited member with no trial of their own still activates on the account (gated on the account's license)", async () => {
  const { pool } = await harness(`
    INSERT INTO users (id, email, license_key_id, email_verified) VALUES (8, 'tech@example.org', NULL, true);
    INSERT INTO memberships (user_id, account_id) VALUES (8, 100);`);
  const r = await R.resolveDesktopLicense(pool, await userRow(pool, 8), { generateLicenseKey: gen, entitled: false, now: Date.parse("2026-10-28T00:00:00Z") });
  assert.deepEqual([r.license.id, r.via], [100, "member"]);
  const r2 = await R.resolveDesktopLicense(pool, await userRow(pool, 8), { generateLicenseKey: gen, entitled: false, now: Date.parse("2026-12-01T00:00:00Z") });
  assert.equal(r2, null, "the account's trial license has expired");
});
