'use strict';
// scripts/smoke-staged-programming.js — pg-mem smoke of the staged_programming endpoint SQL.
// Run: node scripts/smoke-staged-programming.js
const { newDb } = require('pg-mem');
const db = newDb();
db.public.none(`CREATE TABLE staged_programming (
  station_uuid TEXT NOT NULL, table_name TEXT NOT NULL, row_uuid TEXT NOT NULL,
  payload JSONB NOT NULL, deleted_at TIMESTAMPTZ, imported_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (station_uuid, table_name, row_uuid))`);
const { Pool } = db.adapters.createPg();
const pool = new Pool();
const S = 'OV';
// NB: the live endpoint uses `payload = staged_programming.payload || EXCLUDED.payload` (jsonb
// merge, preserves id on edit). pg-mem can't evaluate jsonb-concat, so this smoke uses the plain
// replace form for its other assertions; the merge is proven separately against real Postgres.
const upsert = (t, u, p) => pool.query(
  `INSERT INTO staged_programming (station_uuid, table_name, row_uuid, payload, deleted_at, imported_at, updated_at)
   VALUES ($1,$2,$3,$4,NULL,NULL,NOW())
   ON CONFLICT (station_uuid, table_name, row_uuid) DO UPDATE SET payload=EXCLUDED.payload, deleted_at=NULL, imported_at=NULL, updated_at=NOW()`,
  [S, t, u, JSON.stringify(p)]);
const pending = () => pool.query(
  `SELECT table_name, row_uuid FROM staged_programming WHERE station_uuid=$1 AND deleted_at IS NULL AND imported_at IS NULL
   ORDER BY CASE table_name WHEN 'categories' THEN 0 WHEN 'clocks' THEN 1 WHEN 'shows' THEN 2 WHEN 'clock_slots' THEN 3 ELSE 9 END, updated_at ASC`, [S]);

(async () => {
  const checks = []; const pass = (l, c, d) => checks.push({ l, ok: !!c, d });
  // author out of dependency order on purpose
  await upsert('clock_slots', 'slot-1', { clock_uuid: 'clk', category_uuid: 'cat' });
  await upsert('categories', 'cat', { code: 'PG', name: 'Power Gold', id: 101 });
  await upsert('clocks', 'clk', { name: 'AM' });
  await upsert('shows', 'shw', { name: 'Morning', clock_uuid: 'clk' });

  let p = (await pending()).rows.map(r => r.table_name);
  pass('pending is dependency-ordered: categories,clocks,shows,clock_slots', p.join() === 'categories,clocks,shows,clock_slots', JSON.stringify(p));

  await upsert('categories', 'cat', { code: 'PG', name: 'Power Gold EDIT', id: 101 });
  const after = (await pool.query(`SELECT payload FROM staged_programming WHERE row_uuid='cat'`)).rows[0].payload;
  pass('upsert edits in place (idempotent on row_uuid)', after.name === 'Power Gold EDIT' && (await pending()).rows.filter(r => r.row_uuid === 'cat').length === 1);

  await pool.query(`UPDATE staged_programming SET imported_at=NOW() WHERE station_uuid=$1 AND row_uuid=ANY($2::text[]) AND imported_at IS NULL`, [S, ['cat', 'clk', 'shw', 'slot-1']]);
  pass('mark-imported drops them from pending', (await pending()).rows.length === 0);

  await pool.query(`UPDATE staged_programming SET deleted_at=NOW() WHERE station_uuid=$1 AND table_name='clocks' AND row_uuid='clk' AND deleted_at IS NULL`, [S]);
  pass('soft-delete excludes from list', (await pool.query(`SELECT 1 FROM staged_programming WHERE row_uuid='clk' AND deleted_at IS NULL`)).rows.length === 0);

  console.log('=== STAGED-PROGRAMMING ENDPOINT SQL SMOKE ===');
  let ok = true;
  for (const c of checks) { console.log(`   ${c.ok ? 'PASS' : 'FAIL'}  ${c.l}`); if (!c.ok) { ok = false; console.log('      ', c.d); } }
  console.log('\n=== RESULT:', ok ? 'ENDPOINT SQL OK ✅' : 'FAIL ❌', '===');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERR', e); process.exit(2); });
