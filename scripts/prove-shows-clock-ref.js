'use strict';
// scripts/prove-shows-clock-ref.js
//
// Proves the one core-rotation ref gap is closed: shows.clock_id (the reverse of clocks.show_id) is
// remapped to the receiver's OWN local clock across machines with different local ids. Same real
// stack as prove-dj-bidirectional (REAL handlers + SyncEngine.push/pull + HttpTransport + router +
// MergeEngine). djdeniro already holds the DJ station (local id 1) so OV's clock lands on id 2 there.
//
// Run:  ELECTRON_RUN_AS_NODE=1 OPENAIR_DIR=/c/openair \
//       /c/openair/node_modules/electron/dist/electron.exe scripts/prove-shows-clock-ref.js

const path = require('path');
const express = require('express');
const { newDb } = require('pg-mem');

process.env.SYNC_SERVER_ID = process.env.SYNC_SERVER_ID || 'prove-shows-clock-ref';
const makeSyncRouter = require('../src/routes/sync');

const OPENAIR = process.env.OPENAIR_DIR || 'C:/openair';
const req = (p) => require(path.join(OPENAIR, p));
const Database        = req('node_modules/better-sqlite3');
const { SyncEngine }    = req('electron/sync/sync-engine');
const { HttpTransport } = req('electron/sync/transport-http');
const { REGISTRY }      = req('electron/sync/synced-tables');
const { stationsCreate } = req('electron/sync/handlers/stations');
const { clocksCreate }   = req('electron/sync/handlers/clocks');
const { showsCreate, showsUpdate } = req('electron/sync/handlers/shows');

const SV = 16, OV_ACCOUNT = 1;
const OV_UUID = 'OV-STATION-UUID', DJ_UUID = 'DJ-STATION-UUID', CLOCK_UUID = 'OV-CLOCK-UUID', SHOW_UUID = 'OV-SHOW-UUID';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  const INT = /(^id$|_id$|^position$|^priority$|^spins_per_hour$|^duration_min$|^is_active$|^start_hour$|^end_hour$|_bitrate$|_port$)/;
  return `CREATE TABLE ${name} (${Object.keys(cols).map(c => c === 'id' ? 'id INTEGER PRIMARY KEY AUTOINCREMENT'
    : c === 'uuid' ? 'uuid TEXT NOT NULL UNIQUE' : `${c} ${INT.test(c) ? 'INTEGER' : 'TEXT'}`).join(', ')});`;
}
const SYNCED_DDL = ['stations', 'clocks', 'shows'].map(syncedTableDDL).join('\n');

function makeInstall(label, baseUrl) {
  const db = new Database(':memory:');
  db.exec(INFRA_DDL); db.exec(SYNCED_DDL);
  const clientId = require('crypto').randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SV);
  db.prepare('INSERT INTO client_identity (id, client_id, created_at, label) VALUES (1, ?, ?, ?)').run(clientId, now, label);
  db.prepare("INSERT INTO system_state (key, value, updated_at) VALUES ('hlc_last', ?, ?)").run(`0:0:${clientId}`, now);
  db.prepare("INSERT INTO station_config_kv (station_id, key, value) VALUES (1,'license_key',?)").run(`lk-${label}`);
  const engine = new SyncEngine(db, new HttpTransport(db, { baseUrl, licenseKey: `lk-${label}` }), {
    localSchemaVersion: SV, uuidIdentity: true,
    getStationId:   () => { const s = db.prepare('SELECT id FROM stations WHERE uuid=?').get(OV_UUID); return s ? String(s.id) : null; },
    getStationUuid: () => OV_UUID,
  });
  return { db, engine, clientId, label };
}
const station = (db, uuid, name) => stationsCreate(db, { uuid, name, callsign: '', frequency: '', city: '', state: '', country: 'US',
  website: '', is_active: 0, icecast_server_url: '', icecast_mount: '', icecast_password: '', icecast_bitrate: 128, icecast_format: 'mp3' });
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
  app.use((r, _res, next) => { r.license = { id: OV_ACCOUNT }; next(); });
  app.use('/sync', makeSyncRouter(pool));
  const server = app.listen(0); const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // OV authors a clock and a show that points at it.
  const OV = makeInstall('OV-machine', baseUrl);
  const ovSt = station(OV.db, OV_UUID, 'OV');
  const ovClock = clocksCreate(OV.db, { uuid: CLOCK_UUID, name: 'Drive', show_id: null, description: '', color: '#000', station_id: ovSt.id });
  const ovShow = showsCreate(OV.db, { uuid: SHOW_UUID, name: 'Morning Show', start_hour: 6, end_hour: 10, days: 'MTWTF', color: '#0f0', description: '', is_active: 1, clock_id: ovClock.id, station_id: ovSt.id });
  await OV.engine.push();
  console.log(`=== OV: clock local id=${ovClock.id}, show.clock_id=${ovShow.clock_id} (points at OV's local clock)\n`);

  // djdeniro already holds the DJ station (local id 1) → OV's clock will land on id 2 here.
  const DJ = makeInstall('djdeniro-desktop', baseUrl);
  station(DJ.db, DJ_UUID, 'DJ Deniro');
  clocksCreate(DJ.db, { uuid: 'DJ-OWN-CLOCK', name: 'DJ show', show_id: null, description: '', color: '#111', station_id: 1 });
  DJ.db.prepare("UPDATE mutations SET sync_status='synced' WHERE sync_status='pending'").run();

  console.log('=== DIRECTION 1 — djdeniro pulls OV (clock + show) ===');
  await DJ.engine.pull();
  const djClock = get(DJ.db, 'clocks', CLOCK_UUID), djShow = get(DJ.db, 'shows', SHOW_UUID);
  pass('show arrived on djdeniro', !!djShow);
  pass('OV clock landed on a DIFFERENT local id on djdeniro', djClock && djClock.id !== ovClock.id, djClock && `dj=${djClock.id} vs ov=${ovClock.id}`);
  pass('show.clock_id remapped to djdeniro\'s OWN local clock (not OV\'s integer)', djShow && djClock && djShow.clock_id === djClock.id, djShow && `show.clock_id=${djShow.clock_id} vs dj clock id=${djClock && djClock.id}`);

  console.log('\n=== DIRECTION 2 — djdeniro edits the show, OV pulls ===');
  await sleep(8);
  showsUpdate(DJ.db, SHOW_UUID, { name: 'Morning Show (DJ edit)' });
  await DJ.engine.push();
  await OV.engine.pull();
  const ovShowAfter = get(OV.db, 'shows', SHOW_UUID);
  pass('OV sees djdeniro\'s show edit', ovShowAfter.name === 'Morning Show (DJ edit)', `"${ovShowAfter.name}"`);
  pass('OV show.clock_id still points at OV\'s OWN local clock', ovShowAfter.clock_id === ovClock.id, `=${ovShowAfter.clock_id} vs ${ovClock.id}`);

  server.close();
  const ok = checks.every(Boolean);
  console.log(`\n=== RESULT: ${ok ? 'shows.clock_id remaps correctly across divergent local ids ✅' : 'FAIL ❌'} ===`);
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('PROOF HARNESS ERROR:', e); process.exit(2); });
