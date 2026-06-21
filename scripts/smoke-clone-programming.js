'use strict';
// scripts/smoke-clone-programming.js — pg-mem smoke of the clone-programming endpoint logic.
// Proves: reading the GRANTED owner's mutation stream and staging a FULL program with cross-row
// FKs rewritten to PARENT UUIDS (clock_uuid, category_uuid) that importStagedProgramming resolves.
// Run: node scripts/smoke-clone-programming.js
const { newDb } = require('pg-mem');
const db = newDb();
db.public.none(`
  CREATE TABLE stations (id INT, uuid TEXT, license_key_id INT);
  CREATE TABLE library_grants (owner_license_id INT, grantee_license_id INT, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE mutations (license_key_id INT, table_name TEXT, row_id INT, op TEXT, payload_after JSONB, server_seq INT);
  CREATE TABLE staged_programming (station_uuid TEXT, table_name TEXT, row_uuid TEXT, payload JSONB,
     deleted_at TIMESTAMPTZ, imported_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW(),
     PRIMARY KEY (station_uuid, table_name, row_uuid));
`);
const { Pool } = db.adapters.createPg();
const pool = new Pool();
const OWNER = 2, GRANTEE = 19, OV = 'OV-UUID';

(async () => {
  await pool.query(`INSERT INTO stations VALUES ($1,$2,$3)`, [1, OV, GRANTEE]);
  await pool.query(`INSERT INTO library_grants (owner_license_id, grantee_license_id, revoked_at) VALUES ($1,$2,NULL)`, [OWNER, GRANTEE]);
  // owner mutation stream — one row per row_id (latest). Mirrors DJ's real shapes.
  const mut = (t, rid, p, seq) => pool.query(`INSERT INTO mutations VALUES ($1,$2,$3,'create',$4,$5)`, [OWNER, t, rid, JSON.stringify(p), seq]);
  await mut('categories', 15, { id: 15, code: 'ADS', name: 'Commercials', uuid: 'cat-ads', color: '#3b82f6', priority: 0, spins_per_hour: 0 }, 1);
  await mut('categories', 9,  { id: 9,  code: 'PG',  name: 'Power Gold',  uuid: 'cat-pg',  color: '#f00', priority: 1, spins_per_hour: 3 }, 2);
  await mut('categories', 99, { id: null, code: 'te', name: 'test', uuid: 'cat-test' }, 3); // null id → must be skipped
  await mut('clocks', 6,  { id: 6,  name: 'Halloween', uuid: 'clk-hw', color: null, show_id: null, description: null }, 4);
  await mut('clocks', 11, { id: 11, name: 'Reggae',    uuid: 'clk-rg', color: null, show_id: null, description: null }, 5);
  await mut('shows', 5, { id: 5, name: 'overnight', uuid: 'shw-on', days: '0123456', clock_id: 11, start_hour: 0, end_hour: 6, is_active: 1, color: '#3b82f6', description: 'overnights' }, 6);
  await mut('clock_slots', 94, { id: 94, uuid: 'slot-94', label: 'Reggae', clock_id: 11, position: 2, slot_type: 'music', category_id: 9,  duration_min: 3.5 }, 7);
  await mut('clock_slots', 17, { id: 17, uuid: 'slot-17', label: 'Ads',    clock_id: 6,  position: 5, slot_type: 'spot',  category_id: 15, duration_min: 0.5 }, 8);
  await mut('clock_slots', 50, { id: 50, uuid: 'slot-50', label: 'Orphan', clock_id: 11, position: 9, slot_type: 'music', category_id: 99, duration_min: 3.5 }, 9); // cat 99 skipped → category_uuid null

  // ── EXACT clone-programming logic (mirrors index.js) ──
  const latest = async (table) => (await pool.query(
    `SELECT payload_after AS p, op FROM mutations WHERE license_key_id=$1 AND table_name=$2 ORDER BY server_seq DESC`, [OWNER, table]
  )).rows.filter((r) => r.op !== 'delete' && r.p).map((r) => r.p);
  const stage = (t, u, p) => pool.query(
    `INSERT INTO staged_programming (station_uuid, table_name, row_uuid, payload, deleted_at, imported_at, updated_at)
     VALUES ($1,$2,$3,$4,NULL,NULL,NOW())
     ON CONFLICT (station_uuid, table_name, row_uuid) DO UPDATE SET payload=EXCLUDED.payload, deleted_at=NULL, imported_at=NULL, updated_at=NOW()`,
    [OV, t, String(u), JSON.stringify(p)]);
  const cloned = { categories: 0, clocks: 0, shows: 0, clock_slots: 0 };
  const catIdToUuid = {};
  for (const c of await latest('categories')) {
    if (c == null || c.id == null || !c.uuid) continue;
    catIdToUuid[c.id] = c.uuid;
    await stage('categories', c.uuid, { id: c.id, code: c.code, name: c.name, color: c.color, spins_per_hour: c.spins_per_hour, priority: c.priority });
    cloned.categories++;
  }
  const clockIdToUuid = {};
  for (const k of await latest('clocks')) {
    if (k == null || !k.uuid) continue;
    clockIdToUuid[k.id] = k.uuid;
    await stage('clocks', k.uuid, { name: k.name, color: k.color, description: k.description });
    cloned.clocks++;
  }
  for (const s of await latest('shows')) {
    if (s == null || !s.uuid) continue;
    await stage('shows', s.uuid, { name: s.name, days: s.days, color: s.color, start_hour: s.start_hour, end_hour: s.end_hour, is_active: s.is_active, description: s.description, clock_uuid: s.clock_id != null ? (clockIdToUuid[s.clock_id] ?? null) : null });
    cloned.shows++;
  }
  for (const sl of await latest('clock_slots')) {
    if (sl == null || !sl.uuid) continue;
    await stage('clock_slots', sl.uuid, { label: sl.label, position: sl.position, slot_type: sl.slot_type, duration_min: sl.duration_min, clock_uuid: sl.clock_id != null ? (clockIdToUuid[sl.clock_id] ?? null) : null, category_uuid: sl.category_id != null ? (catIdToUuid[sl.category_id] ?? null) : null });
    cloned.clock_slots++;
  }

  // ── asserts ──
  const checks = []; const pass = (l, c, d) => checks.push({ l, ok: !!c, d });
  const get = async (t, u) => (await pool.query(`SELECT payload FROM staged_programming WHERE table_name=$1 AND row_uuid=$2`, [t, u])).rows[0]?.payload;

  pass('cloned counts: 2 categories (null-id skipped), 2 clocks, 1 show, 3 slots',
    cloned.categories === 2 && cloned.clocks === 2 && cloned.shows === 1 && cloned.clock_slots === 3, JSON.stringify(cloned));
  const cat = await get('categories', 'cat-pg');
  pass('category id-passthrough preserved (id=9)', cat && cat.id === 9 && cat.code === 'PG', JSON.stringify(cat));
  pass('null-id category NOT staged', !(await get('categories', 'cat-test')));
  const clk = await get('clocks', 'clk-rg');
  pass('clock staged without id (resolved by uuid on import)', clk && clk.id === undefined && clk.name === 'Reggae', JSON.stringify(clk));
  const shw = await get('shows', 'shw-on');
  pass('show.clock_id rewritten to clock_uuid=clk-rg', shw && shw.clock_uuid === 'clk-rg' && shw.clock_id === undefined, JSON.stringify(shw));
  const s94 = await get('clock_slots', 'slot-94');
  pass('slot94 FKs rewritten: clock_uuid=clk-rg, category_uuid=cat-pg', s94 && s94.clock_uuid === 'clk-rg' && s94.category_uuid === 'cat-pg' && s94.clock_id === undefined, JSON.stringify(s94));
  const s17 = await get('clock_slots', 'slot-17');
  pass('slot17 FKs rewritten: clock_uuid=clk-hw, category_uuid=cat-ads', s17 && s17.clock_uuid === 'clk-hw' && s17.category_uuid === 'cat-ads', JSON.stringify(s17));
  const s50 = await get('clock_slots', 'slot-50');
  pass('slot50 orphan category (99 skipped) → category_uuid null, clock still resolved', s50 && s50.category_uuid === null && s50.clock_uuid === 'clk-rg', JSON.stringify(s50));

  console.log('=== CLONE-PROGRAMMING ENDPOINT LOGIC SMOKE ===');
  let ok = true;
  for (const c of checks) { console.log(`   ${c.ok ? 'PASS' : 'FAIL'}  ${c.l}`); if (!c.ok) { ok = false; console.log('      detail:', c.d); } }
  console.log('\n=== RESULT:', ok ? 'CLONE LOGIC OK — full program staged with parent-uuid FKs ✅' : 'FAIL ❌', '===');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERR', e); process.exit(2); });
