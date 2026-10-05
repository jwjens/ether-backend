'use strict';
// H2 — the legacy backup store is scoped to the caller's LICENSE; station_id is only a label inside it.
// Real module SQL on in-memory Postgres (pg-mem).   node --test src/lib/legacy-backups.test.js
const test = require("node:test");
const assert = require("node:assert");
const { newDb } = require("pg-mem");
const B = require("./legacy-backups");

const A = "ETH-PRO-AAAA-AAAA-AAAA";   // license A's key
const K = "ETH-PRO-BBBB-BBBB-BBBB";   // license B's key
const T0 = Date.parse("2026-01-01T00:00:00Z");

// Shaped like prod (catalog: id PK, station_id/license_key/filename/size_bytes/checksum/data NOT NULL).
async function freshPool() {
  const pool = new (newDb().adapters.createPg().Pool)();
  await pool.query(`CREATE TABLE backups (
    id          SERIAL PRIMARY KEY,
    station_id  TEXT NOT NULL,
    license_key TEXT NOT NULL,
    filename    TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL,
    checksum    TEXT NOT NULL,
    data        BYTEA NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    description TEXT)`);
  return pool;
}
let seq = 0;
// Explicit created_at so "oldest" is deterministic: each call is one minute later than the last.
async function put(pool, key, station, size = 10) {
  seq++;
  const { rows: [r] } = await pool.query(
    `INSERT INTO backups (station_id, license_key, filename, size_bytes, checksum, data, created_at)
     VALUES ($1,$2,$3,$4,'x',$5,$6) RETURNING id`,
    [station, key, `b${seq}.json.gz`, size, Buffer.from("x"), new Date(T0 + seq * 60000)]);
  return r.id;
}
const ids = async (pool, key) =>
  (await pool.query(`SELECT id FROM backups WHERE license_key = $1 ORDER BY id`, [key])).rows.map(r => r.id);

// ── List ─────────────────────────────────────────────────────────────────────────────────────────────

test("L1. same station_id under two licenses: each lists ONLY its own rows and its own bytes (the H2 defect)", async () => {
  const pool = await freshPool();
  await put(pool, A, "shared@x.com", 100);
  await put(pool, K, "shared@x.com", 7);
  await put(pool, K, "shared@x.com", 7);
  const a = await B.listBackups(pool, A, "shared@x.com");
  assert.strictEqual(a.rows.length, 1);
  assert.strictEqual(a.total, 100);
  const k = await B.listBackups(pool, K, "shared@x.com");
  assert.strictEqual(k.rows.length, 2);
  assert.strictEqual(k.total, 14);
});

test("L2. no station_id: all of the caller's backups across labels, none of anyone else's", async () => {
  const pool = await freshPool();
  await put(pool, A, "a@x.com"); await put(pool, A, "other-label");
  await put(pool, K, "a@x.com");
  const a = await B.listBackups(pool, A, null);
  assert.strictEqual(a.rows.length, 2);
  assert.strictEqual(a.total, 20);
});

test("L3. old-desktop shape (station_id = the license email) returns the caller's rows, newest first", async () => {
  const pool = await freshPool();
  const first = await put(pool, A, "a@x.com");
  const second = await put(pool, A, "a@x.com");
  const a = await B.listBackups(pool, A, "a@x.com");
  assert.deepStrictEqual(a.rows.map(r => r.id), [second, first]);
});

// ── Studio rotation ──────────────────────────────────────────────────────────────────────────────────

test("R1. another license's 30 older rows under the same label are neither counted nor evicted", async () => {
  const pool = await freshPool();
  for (let i = 0; i < 30; i++) await put(pool, K, "X");
  await put(pool, A, "X");
  assert.strictEqual(await B.rotateStudioBackups(pool, A, "X"), 0);
  assert.strictEqual((await ids(pool, K)).length, 30);
  assert.strictEqual((await ids(pool, A)).length, 1);
});

test("R2. at the cap, the CALLER's oldest is evicted — never another license's older row", async () => {
  const pool = await freshPool();
  const kOld = await put(pool, K, "X");                 // the globally oldest row, belongs to K
  const aIds = [];
  for (let i = 0; i < 30; i++) aIds.push(await put(pool, A, "X"));
  assert.strictEqual(await B.rotateStudioBackups(pool, A, "X"), 1);
  assert.deepStrictEqual(await ids(pool, K), [kOld]);
  assert.deepStrictEqual(await ids(pool, A), aIds.slice(1), "A's single oldest went");
});

test("R3. a backlog above the cap clears in one go to keep-1 (room for the insert); others untouched", async () => {
  const pool = await freshPool();
  for (let i = 0; i < 32; i++) await put(pool, A, "X");
  await put(pool, K, "X");
  assert.strictEqual(await B.rotateStudioBackups(pool, A, "X"), 3);
  assert.strictEqual((await ids(pool, A)).length, 29);
  assert.strictEqual((await ids(pool, K)).length, 1);
});

test("R4. under the cap nothing is deleted, and other labels of the caller are not counted", async () => {
  const pool = await freshPool();
  for (let i = 0; i < 29; i++) await put(pool, A, "X");
  for (let i = 0; i < 5; i++) await put(pool, A, "Y");
  assert.strictEqual(await B.rotateStudioBackups(pool, A, "X"), 0);
  assert.strictEqual((await ids(pool, A)).length, 34);
});

// ── Insert / download / delete ───────────────────────────────────────────────────────────────────────

test("I1. insertBackup stores the row under the caller's license key", async () => {
  const pool = await freshPool();
  const row = await B.insertBackup(pool, { licenseKey: A, stationId: "a@x.com", filename: "f.json.gz",
    sizeBytes: 3, checksum: "c", data: Buffer.from("abc"), description: null });
  assert.ok(row.id);
  assert.deepStrictEqual(await ids(pool, A), [row.id]);
});

test("D1. another license can neither download nor delete my backup", async () => {
  const pool = await freshPool();
  const mine = await put(pool, A, "a@x.com");
  assert.strictEqual(await B.getBackup(pool, K, mine), null);
  assert.strictEqual(await B.deleteBackup(pool, K, mine), false);
  assert.deepStrictEqual(await ids(pool, A), [mine]);
});

test("D2. the owner downloads (with data) and deletes its own backup", async () => {
  const pool = await freshPool();
  const mine = await put(pool, A, "a@x.com");
  const b = await B.getBackup(pool, A, mine);
  assert.ok(b && b.data, "data comes back for the owner");
  assert.strictEqual(await B.deleteBackup(pool, A, mine), true);
  assert.deepStrictEqual(await ids(pool, A), []);
});

// ── Guard + wiring ───────────────────────────────────────────────────────────────────────────────────

test("G1. a license with no plaintext key has no legacy storage: refused with 409, never a NULL-key query", () => {
  assert.strictEqual(B.legacyKey({ id: 9, license_key: null }), null);
  assert.strictEqual(B.legacyKey({ id: 9 }), null);
  assert.strictEqual(B.legacyKey(null), null);
  assert.strictEqual(B.legacyKey({ id: 9, license_key: A }), A);
  assert.strictEqual(B.NO_LEGACY_STORAGE.status, 409);
  assert.strictEqual(B.NO_LEGACY_STORAGE.body.error, "legacy_backup_unavailable");
});

test("W1. wired: all four legacy routes guard and go through this module; no station_id-only query is left", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "index.js"), "utf8");
  assert.ok(!/FROM backups WHERE station_id/.test(src), "no unscoped station_id query");
  assert.ok(!/INSERT INTO backups/.test(src), "insert lives in the module");
  assert.ok(!/DELETE FROM backups WHERE id/.test(src), "delete-by-id lives in the module");
  assert.ok(!/SELECT \* FROM backups/.test(src), "download lives in the module");
  assert.strictEqual((src.match(/legacyBackups\.legacyKey\(req\.license\)/g) || []).length, 4, "guard on upload, list, download, delete");
  for (const fn of ["rotateStudioBackups", "insertBackup", "listBackups", "getBackup", "deleteBackup"])
    assert.ok(new RegExp(`legacyBackups\\.${fn}\\(`).test(src), `${fn} is called`);
  // The platform account delete stays license-scoped (unchanged).
  assert.ok(/DELETE FROM backups\s+WHERE license_key = \$1/.test(src), "account delete still scoped by license_key");
});
