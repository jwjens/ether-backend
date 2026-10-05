'use strict';
// H3 — mutation-log retention is PER LICENSE, and the station-delete purge only touches the owning license.
// Real module, real SQL, in-memory Postgres (pg-mem) — the exact statements production runs.
//   node --test src/lib/mutation-retention.test.js
const test = require("node:test");
const assert = require("node:assert");
const { newDb } = require("pg-mem");
const R = require("./mutation-retention");

const DAY = 86400000;
const NOW = Date.now();
const OLD = new Date(NOW - 10 * DAY);   // well outside the 2-day buffer
const FRESH = new Date(NOW - 1000);     // inside the buffer

// The columns retention and the station purge actually touch, shaped like prod (server_seq PK, license NOT NULL).
async function freshPool() {
  const pool = new (newDb().adapters.createPg().Pool)();
  await pool.query(`CREATE TABLE mutations (
    server_seq     BIGSERIAL PRIMARY KEY,
    license_key_id INTEGER NOT NULL,
    station_id     TEXT,
    table_name     TEXT NOT NULL,
    row_id         TEXT NOT NULL,
    op             TEXT NOT NULL DEFAULT 'update',
    received_at    TIMESTAMPTZ NOT NULL)`);
  return pool;
}
// Inserted in call order, so a later call always has the higher server_seq (= "newer").
async function put(pool, { lic, table = "categories", row, at = OLD, station = null, op = "update" }) {
  await pool.query(
    `INSERT INTO mutations (license_key_id, station_id, table_name, row_id, op, received_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [lic, station, table, row, op, at]);
}
async function count(pool, where, params) {
  return Number((await pool.query(`SELECT COUNT(*) AS n FROM mutations WHERE ${where}`, params)).rows[0].n);
}

// ── The seven cases from docs/h3-prune-fix-plan.md §4 V1 ─────────────────────────────────────────────

test("1. cross-license, same row id, both old: EACH license keeps its row (the H3 defect)", async () => {
  const pool = await freshPool();
  await put(pool, { lic: 1, row: "R" });
  await put(pool, { lic: 2, row: "R" });   // newer, other account — the old global prune deleted license 1's row
  assert.strictEqual(await R.pruneSupersededMutations(pool, 2, NOW), 0);
  assert.strictEqual(await count(pool, "license_key_id = 1 AND row_id = 'R'"), 1);
  assert.strictEqual(await count(pool, "license_key_id = 2 AND row_id = 'R'"), 1);
});

test("2. same-license supersession, both old: only the newest survives", async () => {
  const pool = await freshPool();
  await put(pool, { lic: 1, row: "S" });
  await put(pool, { lic: 1, row: "S" });
  assert.strictEqual(await R.pruneSupersededMutations(pool, 2, NOW), 1);
  const left = (await pool.query(`SELECT server_seq FROM mutations WHERE row_id = 'S'`)).rows;
  assert.strictEqual(left.length, 1);
  assert.strictEqual(Number(left[0].server_seq), 2, "the surviving row is the newest server_seq");
});

test("3. newer row inside the buffer: the older (old) row goes, the newer stays", async () => {
  const pool = await freshPool();
  await put(pool, { lic: 1, row: "T", at: OLD });
  await put(pool, { lic: 1, row: "T", at: FRESH });
  assert.strictEqual(await R.pruneSupersededMutations(pool, 2, NOW), 1);
  assert.strictEqual(await count(pool, "row_id = 'T' AND received_at > $1", [new Date(NOW - DAY)]), 1);
});

test("4. both rows inside the buffer: nothing is deleted", async () => {
  const pool = await freshPool();
  await put(pool, { lic: 1, row: "U", at: FRESH });
  await put(pool, { lic: 1, row: "U", at: FRESH });
  assert.strictEqual(await R.pruneSupersededMutations(pool, 2, NOW), 0);
  assert.strictEqual(await count(pool, "row_id = 'U'"), 2);
});

test("5. checkpoints ('__checkpoint__','') across two licenses: one per license survives", async () => {
  const pool = await freshPool();
  for (const lic of [1, 1, 2, 2]) await put(pool, { lic, table: "__checkpoint__", row: "", op: "checkpoint" });
  assert.strictEqual(await R.pruneSupersededMutations(pool, 2, NOW), 2);
  assert.strictEqual(await count(pool, "license_key_id = 1 AND table_name = '__checkpoint__'"), 1);
  assert.strictEqual(await count(pool, "license_key_id = 2 AND table_name = '__checkpoint__'"), 1);
});

test("6. dry-run count == rows the prune deletes, and supersededStats drops by exactly that", async () => {
  const pool = await freshPool();
  await put(pool, { lic: 1, row: "A" }); await put(pool, { lic: 1, row: "A" }); await put(pool, { lic: 1, row: "A" });
  await put(pool, { lic: 2, row: "A" });                                        // other license, same id
  await put(pool, { lic: 2, row: "B", at: OLD }); await put(pool, { lic: 2, row: "B", at: FRESH });
  await put(pool, { lic: 1, row: "C", at: FRESH }); await put(pool, { lic: 1, row: "C", at: FRESH }); // superseded but in buffer
  const before = await R.supersededStats(pool);
  const would = Number(await R.countPrunable(pool, 2, NOW));
  assert.strictEqual(would, 3, "lic1 A x2 + lic2 B x1 (lic1 C is inside the buffer)");
  assert.strictEqual(Number(before.total), 8, "3 + 1 + 2 + 2 rows seeded");
  assert.strictEqual(Number(before.superseded), 4, "per (license,table,row): A(lic1) 2 + B 1 + C 1");
  const deleted = await R.pruneSupersededMutations(pool, 2, NOW);
  assert.strictEqual(deleted, would);
  const after = await R.supersededStats(pool);
  assert.strictEqual(Number(after.total), Number(before.total) - deleted);
  assert.strictEqual(Number(after.superseded), Number(before.superseded) - deleted);
});

test("7. regression guard: another license's newer write to my uuid never removes MY latest row from my reader", async () => {
  const pool = await freshPool();
  await put(pool, { lic: 1, row: "cat-uuid" });   // owner's only (latest) row — what clone/borrowed readers and pull need
  await put(pool, { lic: 2, row: "cat-uuid" });   // grantee/attacker writes the SAME uuid, newer
  await put(pool, { lic: 2, row: "cat-uuid" });
  await R.pruneSupersededMutations(pool, 2, NOW);
  // The owner-scoped "latest per row" read (clone-programming / borrowed-library / pull shape).
  const mine = (await pool.query(
    `SELECT row_id, MAX(server_seq) AS s FROM mutations WHERE license_key_id = 1 AND table_name = 'categories' GROUP BY row_id`)).rows;
  assert.deepStrictEqual(mine.map(r => r.row_id), ["cat-uuid"]);
  assert.strictEqual(await count(pool, "license_key_id = 2 AND row_id = 'cat-uuid'"), 1, "lic2 thinned only by its own newer write");
});

// ── Station-delete purge, scoped to the owning license (H3 adjacent) ─────────────────────────────────

test("station delete: removes the owner's station-scoped rows and its 'stations' row", async () => {
  const pool = await freshPool();
  await put(pool, { lic: 1, table: "categories", row: "c1", station: "st-A" });
  await put(pool, { lic: 1, table: "stations", row: "st-A" });
  assert.strictEqual(await R.deleteStationMutations(pool, 1, "st-A"), 2);
  assert.strictEqual(await count(pool, "TRUE"), 0);
});

test("station delete: another license's rows naming the same uuid are left alone", async () => {
  const pool = await freshPool();
  await put(pool, { lic: 1, table: "categories", row: "c1", station: "st-A" });
  await put(pool, { lic: 2, table: "categories", row: "x1", station: "st-A" });  // foreign row naming my station
  await put(pool, { lic: 2, table: "stations", row: "st-A" });                   // foreign 'stations' row for my uuid
  assert.strictEqual(await R.deleteStationMutations(pool, 1, "st-A"), 1);
  assert.strictEqual(await count(pool, "license_key_id = 2"), 2);
});

test("station delete: the owner's OTHER stations and install-scope rows are untouched", async () => {
  const pool = await freshPool();
  await put(pool, { lic: 1, table: "categories", row: "c1", station: "st-A" });
  await put(pool, { lic: 1, table: "categories", row: "c2", station: "st-B" });
  await put(pool, { lic: 1, table: "songs", row: "s1", station: null });          // install-scope
  await put(pool, { lic: 1, table: "stations", row: "st-B" });
  assert.strictEqual(await R.deleteStationMutations(pool, 1, "st-A"), 1);
  assert.strictEqual(await count(pool, "license_key_id = 1"), 3);
});

test("station delete: a license that does not own the uuid deletes nothing of the owner's", async () => {
  const pool = await freshPool();
  await put(pool, { lic: 1, table: "categories", row: "c1", station: "st-A" });
  await put(pool, { lic: 1, table: "stations", row: "st-A" });
  assert.strictEqual(await R.deleteStationMutations(pool, 2, "st-A"), 0);
  assert.strictEqual(await count(pool, "license_key_id = 1"), 2);
});

test("wired: index.js runs every prune/count/stat and all three station purges through this module", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "index.js"), "utf8");
  assert.ok(!/GROUP BY table_name, row_id/.test(src), "no global (table,row) grouping left in index.js");
  assert.ok(!/DELETE FROM mutations m\b/.test(src), "no inline prune left in index.js");
  assert.ok(!/DELETE FROM mutations WHERE station_id/.test(src), "no unscoped station purge left in index.js");
  assert.strictEqual((src.match(/mutationRetention\.deleteStationMutations\(/g) || []).length, 3, "platform, dashboard and desktop station deletes");
  assert.strictEqual((src.match(/mutationRetention\.pruneSupersededMutations\(/g) || []).length, 2, "daily timer + platform prune");
  assert.ok(/mutationRetention\.countPrunable\(/.test(src), "platform dry run");
  assert.ok(/mutationRetention\.supersededStats\(/.test(src), "db-stats");
});

test("cutoff: bufferDays back from now", () => {
  assert.strictEqual(R.cutoff(2, NOW).getTime(), NOW - 2 * DAY);
});
