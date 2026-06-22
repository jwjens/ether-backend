'use strict';
// scripts/prove-dj-bidirectional.js
//
// Proves the Tier-2 UUID-identity fix: edits sync BOTH ways between the OV machine and djdeniro's
// machine through the cloud, across DIFFERENT local station ids. Drives the REAL stack end to end:
// REAL handlers → REAL SyncEngine.push/pull (uuidIdentity on) → REAL HttpTransport → REAL
// makeSyncRouter (pg-mem) → REAL MergeEngine.apply (with the uuid→local remap).
//
// djdeniro's install ALREADY has the DJ station (local id 1), so OV lands on local id 2 there —
// the exact divergent case that silently missed before the fix.
//
// Run:  ELECTRON_RUN_AS_NODE=1 OPENAIR_DIR=/c/openair \
//       /c/openair/node_modules/electron/dist/electron.exe scripts/prove-dj-bidirectional.js

const path = require('path');
const express = require('express');
const { newDb } = require('pg-mem');

process.env.SYNC_SERVER_ID = process.env.SYNC_SERVER_ID || 'prove-dj-bidirectional';
const makeSyncRouter = require('../src/routes/sync');

const OPENAIR = process.env.OPENAIR_DIR || 'C:/openair';
const req = (p) => require(path.join(OPENAIR, p));
const Database          = req('node_modules/better-sqlite3');
const { SyncEngine }      = req('electron/sync/sync-engine');
const { HttpTransport }   = req('electron/sync/transport-http');
const { REGISTRY }        = req('electron/sync/synced-tables');
const { stationsCreate }   = req('electron/sync/handlers/stations');
const { categoriesCreate } = req('electron/sync/handlers/categories');
const { clocksCreate, clocksUpdate } = req('electron/sync/handlers/clocks');
const { clockSlotsCreate } = req('electron/sync/handlers/clock_slots');

const SV = 16, OV_ACCOUNT = 1;
const OV_UUID = 'OV-STATION-UUID', DJ_UUID = 'DJ-STATION-UUID';
const CAT_UUID = 'OV-CAT-UUID', CLOCK_UUID = 'OV-CLOCK-UUID', SLOTS = ['OV-SLOT-0', 'OV-SLOT-1'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));   // real gap → distinct HLC wall (handoffs aren't same-ms)

const INFRA_DDL = `
  CREATE TABLE schema_version (version INTEGER NOT NULL);
  CREATE TABLE client_identity (id INTEGER PRIMARY KEY CHECK (id = 1), client_id TEXT NOT NULL, created_at TEXT NOT NULL, label TEXT);
  CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE station_config_kv (station_id INTEGER, key TEXT, value TEXT);
  CREATE TABLE mutations (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, station_id TEXT, actor_id TEXT, table_name TEXT NOT NULL,
    row_id TEXT NOT NULL, op TEXT NOT NULL, payload_before TEXT, payload_after TEXT, created_at TEXT NOT NULL, applied_at TEXT NOT NULL,
    hlc TEXT NOT NULL, parent_mutation_id TEXT, schema_version INTEGER NOT NULL, origin TEXT NOT NULL, sync_status TEXT NOT NULL, conflict_resolution TEXT);
  CREATE TABLE quarantine_mutations (id TEXT PRIMARY KEY, raw_json TEXT NOT NULL, foreign_schema_version INTEGER NOT NULL,
    local_schema_version INTEGER NOT NULL, received_at TEXT NOT NULL, drain_status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0, retry_after TEXT);
`;
function syncedTableDDL(name) {
  const cols = { ...REGISTRY[name].columns };
  if (name === 'clock_slots') cols.song_id = 'scalar';
  const INT = /(^id$|_id$|^position$|^priority$|^spins_per_hour$|^duration_min$|^is_active$|_bitrate$|_port$)/;
  return `CREATE TABLE ${name} (${Object.keys(cols).map(c => c === 'id' ? 'id INTEGER PRIMARY KEY AUTOINCREMENT'
    : c === 'uuid' ? 'uuid TEXT NOT NULL UNIQUE' : `${c} ${INT.test(c) ? 'INTEGER' : 'TEXT'}`).join(', ')});`;
}
const SYNCED_DDL = ['stations', 'categories', 'clocks', 'clock_slots'].map(syncedTableDDL).join('\n');

function makeInstall(label, baseUrl) {
  const db = new Database(':memory:');
  db.exec(INFRA_DDL); db.exec(SYNCED_DDL);
  const clientId = require('crypto').randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SV);
  db.prepare('INSERT INTO client_identity (id, client_id, created_at, label) VALUES (1, ?, ?, ?)').run(clientId, now, label);
  db.prepare("INSERT INTO system_state (key, value, updated_at) VALUES ('hlc_last', ?, ?)").run(`0:0:${clientId}`, now);
  db.prepare("INSERT INTO station_config_kv (station_id, key, value) VALUES (1,'license_key',?)").run(`lk-${label}`);
  const transport = new HttpTransport(db, { baseUrl, licenseKey: `lk-${label}` });
  const engine = new SyncEngine(db, transport, {
    localSchemaVersion: SV, uuidIdentity: true,
    getStationId:   () => { const s = db.prepare('SELECT id FROM stations WHERE uuid=?').get(OV_UUID); return s ? String(s.id) : null; },
    getStationUuid: () => OV_UUID,
  });
  return { db, engine, clientId, label };
}
function station(db, uuid, name) {
  return stationsCreate(db, { uuid, name, callsign: '', frequency: '', city: '', state: '', country: 'US', website: '',
    is_active: 0, icecast_server_url: '', icecast_mount: '', icecast_password: '', icecast_bitrate: 128, icecast_format: 'mp3' });
}
const get = (db, t, uuid) => db.prepare(`SELECT * FROM ${t} WHERE uuid = ?`).get(uuid);
const checks = []; const pass = (l, ok, d) => { checks.push(ok); console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${l}${d ? `  (${d})` : ''}`); };

(async () => {
  const pg = newDb();
  pg.public.none(`CREATE TABLE licenses (id SERIAL PRIMARY KEY, email TEXT)`);
  pg.public.none(`CREATE TABLE mutations (server_seq BIGSERIAL PRIMARY KEY, id TEXT, client_id TEXT, station_id TEXT, operator_id TEXT,
    license_key_id INTEGER, table_name TEXT, row_id TEXT, op TEXT, payload_before JSONB, payload_after JSONB, created_at TIMESTAMPTZ,
    hlc TEXT, parent_mutation_id TEXT, schema_version INTEGER, conflict_resolution JSONB, station_uuid TEXT, ref_uuids JSONB,
    CONSTRAINT u UNIQUE (license_key_id, id))`);
  pg.public.none(`CREATE TABLE library_grants (id SERIAL PRIMARY KEY, owner_license_id INTEGER, grantee_license_id INTEGER, created_at TIMESTAMPTZ DEFAULT NOW(), revoked_at TIMESTAMPTZ)`);
  const { Pool } = pg.adapters.createPg(); const pool = new Pool();
  await pool.query(`INSERT INTO licenses (id, email) VALUES (1,'ov-account')`);
  const app = express(); app.use(express.json());
  app.use((r, _res, next) => { r.license = { id: OV_ACCOUNT }; next(); });  // both sync the OV account (member re-scope works)
  app.use('/sync', makeSyncRouter(pool));
  const server = app.listen(0); const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // OV machine authors OV programming (OV is local id 1 here) and pushes it.
  const OV = makeInstall('OV-machine', baseUrl);
  const ovSt = station(OV.db, OV_UUID, 'OV');
  const ovCat = categoriesCreate(OV.db, { uuid: CAT_UUID, code: 'PG', name: 'Power Gold', color: '#fff', spins_per_hour: 4, priority: 1, station_id: ovSt.id });
  const ovClock = clocksCreate(OV.db, { uuid: CLOCK_UUID, name: 'Afternoon Drive', show_id: null, description: '', color: '#000', station_id: ovSt.id });
  SLOTS.forEach((u, i) => clockSlotsCreate(OV.db, { uuid: u, clock_id: ovClock.id, position: i, slot_type: 'category', category_id: ovCat.id, song_id: null, label: `slot${i}`, duration_min: 3, spot_type: null, station_id: ovSt.id }));
  await OV.engine.push();
  console.log(`=== OV authored programming (OV is local id ${ovSt.id} on the OV machine), pushed to cloud\n`);

  // djdeniro's desktop ALREADY has the DJ station (local id 1). Its own data is its own account — mark
  // synced so we don't push it to OV's account; it just occupies local id 1.
  const DJ = makeInstall('djdeniro-desktop', baseUrl);
  const djSt = station(DJ.db, DJ_UUID, 'DJ Deniro');
  clocksCreate(DJ.db, { uuid: 'DJ-OWN-CLOCK', name: 'DJ show', show_id: null, description: '', color: '#111', station_id: djSt.id });
  DJ.db.prepare("UPDATE mutations SET sync_status='synced' WHERE sync_status='pending'").run();
  console.log(`=== djdeniro desktop already holds the DJ station at local id ${djSt.id}\n`);

  // ── DIRECTION 1: OV's programming → djdeniro (down the cloud) ─────────────────
  console.log('=== DIRECTION 1 — djdeniro pulls OV programming ===');
  await DJ.engine.pull();
  const djOv = get(DJ.db, 'stations', OV_UUID), djCat = get(DJ.db, 'categories', CAT_UUID), djClock = get(DJ.db, 'clocks', CLOCK_UUID);
  const djSlots = SLOTS.map(u => get(DJ.db, 'clock_slots', u)).filter(Boolean);
  pass('OV station arrived on djdeniro', !!djOv, djOv && `local id ${djOv.id} (≠1: DJ holds 1)`);
  pass('OV clock + both slots arrived', !!djClock && djSlots.length === 2, `clock=${!!djClock} slots=${djSlots.length}`);
  pass('clock.station_id remapped to djdeniro\'s OWN OV station', djClock && djOv && djClock.station_id === djOv.id, djClock && `=${djClock.station_id} vs ${djOv && djOv.id}`);
  pass('slot.clock_id remapped to djdeniro\'s OWN clock', djSlots.length === 2 && djClock && djSlots.every(s => s.clock_id === djClock.id), djSlots[0] && `=${djSlots[0].clock_id} vs ${djClock && djClock.id}`);
  pass('slot.category_id remapped to djdeniro\'s OWN category', djSlots.length === 2 && djCat && djSlots.every(s => s.category_id === djCat.id), djSlots[0] && `=${djSlots[0].category_id} vs ${djCat && djCat.id}`);

  // ── DIRECTION 2a: edit on OV → djdeniro sees it ──────────────────────────────
  console.log('\n=== DIRECTION 2a — OV edits the clock, djdeniro pulls ===');
  await sleep(8);
  clocksUpdate(OV.db, CLOCK_UUID, { name: 'OV edit: Drive w/ Jeff' });
  await OV.engine.push();
  await DJ.engine.pull();
  pass('djdeniro sees OV\'s edit', get(DJ.db, 'clocks', CLOCK_UUID).name === 'OV edit: Drive w/ Jeff', `"${get(DJ.db, 'clocks', CLOCK_UUID).name}"`);

  // ── DIRECTION 2b: edit on djdeniro → OV sees it ──────────────────────────────
  console.log('\n=== DIRECTION 2b — djdeniro edits the clock, OV pulls ===');
  await sleep(8);
  clocksUpdate(DJ.db, CLOCK_UUID, { name: 'DJ edit: Drive w/ DJ Deniro' });
  await DJ.engine.push();
  await OV.engine.pull();
  pass('OV sees djdeniro\'s edit', get(OV.db, 'clocks', CLOCK_UUID).name === 'DJ edit: Drive w/ DJ Deniro', `"${get(OV.db, 'clocks', CLOCK_UUID).name}"`);
  // and nothing got mis-scoped by the round trip:
  pass('OV clock still scoped to OV\'s local station 1', get(OV.db, 'clocks', CLOCK_UUID).station_id === ovSt.id, `=${get(OV.db, 'clocks', CLOCK_UUID).station_id}`);
  pass('djdeniro clock still scoped to djdeniro\'s local OV station', get(DJ.db, 'clocks', CLOCK_UUID).station_id === djOv.id, `=${get(DJ.db, 'clocks', CLOCK_UUID).station_id}`);

  server.close();
  const ok = checks.every(Boolean);
  console.log(`\n=== RESULT: ${ok ? 'BIDIRECTIONAL SYNC WORKS across divergent local ids ✅' : 'FAIL ❌'} ===`);
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('PROOF HARNESS ERROR:', e); process.exit(2); });
