'use strict';
// scripts/prove-rebaseline.js
//
// Proves the re-baseline mechanism: an install that missed another machine's station programming
// under LEGACY local-integer scoping recovers it after UUID-identity is enabled — via a cursor reset
// + re-pull — with the Tier-2 merge resolving to THIS install's EXISTING local ids and NEVER
// renumbering its own rows. Real stack (handlers + SyncEngine + HttpTransport + router + MergeEngine).
//
// Run:  ELECTRON_RUN_AS_NODE=1 OPENAIR_DIR=/c/openair \
//       /c/openair/node_modules/electron/dist/electron.exe scripts/prove-rebaseline.js

const path = require('path');
const express = require('express');
const { newDb } = require('pg-mem');

process.env.SYNC_SERVER_ID = process.env.SYNC_SERVER_ID || 'prove-rebaseline';
const makeSyncRouter = require('../src/routes/sync');

const OPENAIR = process.env.OPENAIR_DIR || 'C:/openair';
const req = (p) => require(path.join(OPENAIR, p));
const Database        = req('node_modules/better-sqlite3');
const { SyncEngine }    = req('electron/sync/sync-engine');
const { HttpTransport } = req('electron/sync/transport-http');
const { REGISTRY }      = req('electron/sync/synced-tables');
const { stationsCreate, stationsUpdate } = req('electron/sync/handlers/stations');
const { categoriesCreate } = req('electron/sync/handlers/categories');
const { clocksCreate } = req('electron/sync/handlers/clocks');
const { clockSlotsCreate } = req('electron/sync/handlers/clock_slots');

const SV = 16, OV_ACCOUNT = 1;
const OV_UUID = 'OV-STATION', DJ_UUID = 'DJ-STATION', CAT_UUID = 'OV-CAT', CLOCK_UUID = 'OV-CLOCK', SLOT_UUID = 'OV-SLOT';

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
function ddl(name) {
  const cols = { ...REGISTRY[name].columns };
  if (name === 'clock_slots') cols.song_id = 'scalar';
  const INT = /(^id$|_id$|^position$|^priority$|^spins_per_hour$|^duration_min$|^is_active$|^start_hour$|^end_hour$|_bitrate$|_port$)/;
  return `CREATE TABLE ${name} (${Object.keys(cols).map(c => c === 'id' ? 'id INTEGER PRIMARY KEY AUTOINCREMENT'
    : c === 'uuid' ? 'uuid TEXT NOT NULL UNIQUE' : `${c} ${INT.test(c) ? 'INTEGER' : 'TEXT'}`).join(', ')});`;
}
const SYNCED_DDL = ['stations', 'categories', 'clocks', 'clock_slots'].map(ddl).join('\n');

function makeDb(label) {
  const db = new Database(':memory:');
  db.exec(INFRA_DDL); db.exec(SYNCED_DDL);
  const clientId = require('crypto').randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SV);
  db.prepare('INSERT INTO client_identity (id, client_id, created_at, label) VALUES (1, ?, ?, ?)').run(clientId, now, label);
  db.prepare("INSERT INTO system_state (key, value, updated_at) VALUES ('hlc_last', ?, ?)").run(`0:0:${clientId}`, now);
  db.prepare("INSERT INTO station_config_kv (station_id, key, value) VALUES (1,'license_key',?)").run(`lk-${label}`);
  return db;
}
function engine(db, baseUrl, { uuidIdentity }) {
  return new SyncEngine(db, new HttpTransport(db, { baseUrl, licenseKey: 'lk' }), {
    localSchemaVersion: SV, uuidIdentity,
    getStationId:   () => { const s = db.prepare('SELECT id FROM stations WHERE uuid=?').get(OV_UUID); return s ? String(s.id) : null; },
    getStationUuid: () => OV_UUID,
  });
}
const mkStation = (db, uuid, name) => stationsCreate(db, { uuid, name, callsign: '', frequency: '', city: '', state: '', country: 'US',
  website: '', is_active: 0, icecast_server_url: '', icecast_mount: '', icecast_password: '', icecast_bitrate: 128, icecast_format: 'mp3' });
const get = (db, t, uuid) => db.prepare(`SELECT * FROM ${t} WHERE uuid = ?`).get(uuid);
const count = (db, t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
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

  // OV authors programming (Tier-2 on), then a later install-scope edit (station rename) so its
  // server_seq lands ABOVE the programming — this is what advances a puller's cursor past the
  // programming and makes the cursor reset load-bearing.
  const ovDb = makeDb('OV'); const OV = engine(ovDb, baseUrl, { uuidIdentity: true });
  const ovSt = mkStation(ovDb, OV_UUID, 'OV').id;
  const cat = categoriesCreate(ovDb, { uuid: CAT_UUID, code: 'PG', name: 'PG', color: '#fff', spins_per_hour: 4, priority: 1, station_id: ovSt }).id;
  const clk = clocksCreate(ovDb, { uuid: CLOCK_UUID, name: 'Drive', show_id: null, description: '', color: '#000', station_id: ovSt }).id;
  clockSlotsCreate(ovDb, { uuid: SLOT_UUID, clock_id: clk, position: 0, slot_type: 'category', category_id: cat, song_id: null, label: 's', duration_min: 3, spot_type: null, station_id: ovSt });
  await OV.push();
  stationsUpdate(ovDb, OV_UUID, { name: 'OV (renamed later)' });   // install-scope, higher server_seq
  await OV.push();
  console.log('=== OV authored programming + a later install-scope edit, pushed\n');

  // djdeniro already holds the DJ station + clock (local id 1). FIRST it syncs under LEGACY scoping.
  const djDb = makeDb('DJ');
  mkStation(djDb, DJ_UUID, 'DJ');
  const djClock = clocksCreate(djDb, { uuid: 'DJ-OWN-CLOCK', name: 'DJ show', show_id: null, description: '', color: '#111', station_id: 1 }).id;
  djDb.prepare("UPDATE mutations SET sync_status='synced' WHERE sync_status='pending'").run();

  console.log('=== djdeniro syncs under LEGACY (uuid-identity OFF) ===');
  const legacy = engine(djDb, baseUrl, { uuidIdentity: false });
  for (let i = 0; i < 4; i++) await legacy.pull();   // drain: gets OV station + the rename (install-scope); misses programming
  pass('legacy: OV station row arrived', !!get(djDb, 'stations', OV_UUID), `OV local id ${get(djDb,'stations',OV_UUID)?.id}`);
  pass('legacy: OV programming MISSED (clock not delivered)', !get(djDb, 'clocks', CLOCK_UUID), `OV clocks present locally: ${count(djDb,'clocks')-1}`);
  const cursorAfterLegacy = parseInt(djDb.prepare("SELECT value FROM system_state WHERE key='sync_server_seq'").get()?.value || '0', 10);
  console.log(`   djdeniro cursor=${cursorAfterLegacy} (advanced past the programming by the later rename)\n`);

  console.log('=== flag flips ON; first a plain incremental pull, then re-baseline ===');
  const tier2 = engine(djDb, baseUrl, { uuidIdentity: true });
  await tier2.pull();   // incremental from the advanced cursor — should NOT recover the missed programming
  pass('plain incremental pull does NOT recover it (cursor is past it)', !get(djDb, 'clocks', CLOCK_UUID), 'cursor reset is required');

  const r = await tier2.rebaseline();
  console.log(`   rebaseline → applied=${r.applied} dangling ${r.danglingBefore}→${r.danglingAfter}\n`);
  const ovClock = get(djDb, 'clocks', CLOCK_UUID), ovSlot = get(djDb, 'clock_slots', SLOT_UUID);
  const djOv = get(djDb, 'stations', OV_UUID);
  pass('re-baseline recovered OV clock + slot', !!ovClock && !!ovSlot);
  pass('recovered rows remapped to djdeniro local ids (slot.clock_id → its clock)', ovClock && ovSlot && ovSlot.clock_id === ovClock.id, ovSlot && `slot.clock_id=${ovSlot.clock_id} clock.id=${ovClock.id}`);
  pass('recovered clock.station_id → djdeniro OWN OV station', ovClock && djOv && ovClock.station_id === djOv.id, ovClock && `=${ovClock.station_id} vs ${djOv?.id}`);
  pass('NO renumber: djdeniro OWN DJ clock kept its local id', get(djDb, 'clocks', 'DJ-OWN-CLOCK')?.id === djClock, `=${get(djDb,'clocks','DJ-OWN-CLOCK')?.id} (was ${djClock})`);
  pass('re-baseline scan reports zero dangling refs afterward', r.danglingAfter === 0, `dangling=${r.danglingAfter}`);
  pass('re-baseline is one-shot (second call skips)', (await tier2.rebaseline()).skipped === 'already done');

  server.close();
  const ok = checks.every(Boolean);
  console.log(`\n=== RESULT: ${ok ? 're-baseline recovers missed programming, resolve-to-existing, no renumber ✅' : 'FAIL ❌'} ===`);
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('PROOF HARNESS ERROR:', e); process.exit(2); });
