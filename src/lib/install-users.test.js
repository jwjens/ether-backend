'use strict';
// A computer's list only adds or updates; only an explicit removal removes (Jeff, 2026-10-27): src/lib/install-users.js.
//   node --test src/lib/install-users.test.js
const test = require("node:test");
const assert = require("node:assert");
const { newDb } = require("pg-mem");
const { syncInstallUsers } = require("./install-users");

const LIC = 24, OTHER = 22;

async function freshDb() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await pool.query(`CREATE TABLE account_users (
    id SERIAL PRIMARY KEY, license_key_id INTEGER NOT NULL, username TEXT NOT NULL, display_name TEXT,
    role TEXT NOT NULL DEFAULT 'user', pin_hash TEXT NOT NULL, failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ, origin TEXT NOT NULL DEFAULT 'dashboard')`);
  return pool;
}
const live = async (pool, lic = LIC) =>
  (await pool.query(`SELECT username FROM account_users WHERE license_key_id = $1 AND deleted_at IS NULL ORDER BY username`, [lic]))
    .rows.map(r => r.username);
const u = (name, pin_hash = "salt:hash", role = "user") => ({ name, role, pin_hash });

test("two computers pushing different lists no longer flip the account's users", async () => {
  const pool = await freshDb();
  // Computer A (OVEVENTS) knows Admin, jeff, Steve, Donavon; computer B (an older build) knows Admin, ryan, shawna.
  await syncInstallUsers(pool, LIC, { users: [u("Admin"), u("jeff"), u("Steve"), u("Donavon")] });
  const r = await syncInstallUsers(pool, LIC, { users: [u("Admin"), u("ryan"), u("shawna")] });
  assert.strictEqual(r.revoked, 0);
  assert.deepStrictEqual(await live(pool), ["Admin", "Donavon", "Steve", "jeff", "ryan", "shawna"]);
  // and back again: still nobody removed
  await syncInstallUsers(pool, LIC, { users: [u("Admin"), u("jeff")] });
  assert.deepStrictEqual(await live(pool), ["Admin", "Donavon", "Steve", "jeff", "ryan", "shawna"]);
});

test("an explicit removal removes that user, and only that user", async () => {
  const pool = await freshDb();
  await syncInstallUsers(pool, LIC, { users: [u("Admin"), u("jeff"), u("Steve")] });
  const r = await syncInstallUsers(pool, LIC, { users: [u("Admin")], removed: ["steve"] });
  assert.strictEqual(r.revoked, 1);
  assert.deepStrictEqual(await live(pool), ["Admin", "jeff"]);
});

test("a name both sent and removed is kept", async () => {
  const pool = await freshDb();
  await syncInstallUsers(pool, LIC, { users: [u("jeff")] });
  const r = await syncInstallUsers(pool, LIC, { users: [u("jeff")], removed: ["jeff"] });
  assert.strictEqual(r.revoked, 0);
  assert.deepStrictEqual(await live(pool), ["jeff"]);
});

test("a removed user can be added again later", async () => {
  const pool = await freshDb();
  await syncInstallUsers(pool, LIC, { users: [u("jeff")] });
  await syncInstallUsers(pool, LIC, { users: [], removed: ["jeff"] });
  assert.deepStrictEqual(await live(pool), []);
  await syncInstallUsers(pool, LIC, { users: [u("jeff", "salt:new")] });
  assert.deepStrictEqual(await live(pool), ["jeff"]);
});

test("updates the PIN and role of an install user", async () => {
  const pool = await freshDb();
  await syncInstallUsers(pool, LIC, { users: [u("jeff", "salt:old", "user")] });
  const r = await syncInstallUsers(pool, LIC, { users: [u("jeff", "scrypt:new", "admin")] });
  assert.strictEqual(r.updated, 1);
  const row = (await pool.query(`SELECT pin_hash, role FROM account_users WHERE username = 'jeff' AND deleted_at IS NULL`)).rows[0];
  assert.deepStrictEqual([row.pin_hash, row.role], ["scrypt:new", "admin"]);
});

test("a dashboard-managed user is never changed or removed by a computer", async () => {
  const pool = await freshDb();
  await pool.query(`INSERT INTO account_users (license_key_id, username, role, pin_hash, origin) VALUES ($1, 'Boss', 'admin', 'web:pin', 'dashboard')`, [LIC]);
  const r = await syncInstallUsers(pool, LIC, { users: [u("Boss", "salt:x", "user")], removed: ["Boss"] });
  assert.deepStrictEqual([r.skipped, r.revoked], [1, 0]);
  const row = (await pool.query(`SELECT pin_hash, role, deleted_at FROM account_users WHERE username = 'Boss'`)).rows[0];
  assert.deepStrictEqual([row.pin_hash, row.role, row.deleted_at], ["web:pin", "admin", null]);
});

test("another license's users are never touched", async () => {
  const pool = await freshDb();
  await syncInstallUsers(pool, OTHER, { users: [u("jeff")] });
  await syncInstallUsers(pool, LIC, { users: [u("Admin")], removed: ["jeff"] });
  assert.deepStrictEqual(await live(pool, OTHER), ["jeff"]);
});

test("users without a PIN or with an invalid name are skipped", async () => {
  const pool = await freshDb();
  const r = await syncInstallUsers(pool, LIC, { users: [u("nopin", null), u("bad/name"), u("ok")] });
  assert.deepStrictEqual([r.created, r.skipped], [1, 2]);
});
