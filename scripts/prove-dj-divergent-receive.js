'use strict';
// scripts/prove-dj-divergent-receive.js
//
// THE specific real case (read-only — changes nothing): djdeniro's actual desktop ALREADY has the
// DJ station on it (local id 1). As a member of OV's account he pulls OV's programming. OV was
// authored on OV's machine where OV is local id 1, but on djdeniro's machine OV lands on a DIFFERENT
// local id (2, because DJ already occupies 1). Question: does OV's programming ARRIVE, or silently miss?
//
// Drives the REAL code: REAL handlers (mutation gen) + REAL makeSyncRouter (the station_id-scoped
// pull) + REAL openair MergeEngine (apply). The member license re-scope is modelled by pulling
// under OV's account license (that part works); the failure under test is the STATION scoping.
//
// Run:  ELECTRON_RUN_AS_NODE=1 OPENAIR_DIR=/c/openair \
//       /c/openair/node_modules/electron/dist/electron.exe scripts/prove-dj-divergent-receive.js

const path = require('path');
const http = require('http');
const express = require('express');
const { newDb } = require('pg-mem');

process.env.SYNC_SERVER_ID = process.env.SYNC_SERVER_ID || 'prove-dj-divergent-receive';
const makeSyncRouter = require('../src/routes/sync');

const OPENAIR = process.env.OPENAIR_DIR || 'C:/openair';
const req = (p) => require(path.join(OPENAIR, p));
const Database          = req('node_modules/better-sqlite3');
const { MergeEngine }     = req('electron/sync/merge-engine');
const { CausalOrderQueue } = req('electron/sync/causal-order');
const { toWireFormat }     = req('electron/sync/mutation-writer');
const { REGISTRY }         = req('electron/sync/synced-tables');
const { stationsCreate }   = req('electron/sync/handlers/stations');
const { categoriesCreate } = req('electron/sync/handlers/categories');
const { clocksCreate }     = req('electron/sync/handlers/clocks');
const { clockSlotsCreate } = req('electron/sync/handlers/clock_slots');

const SV = 16, OV_ACCOUNT = 1;
const OV_UUID = 'OV-STATION-UUID', DJ_UUID = 'DJ-STATION-UUID';
const CAT_UUID = 'OV-CAT-UUID', CLOCK_UUID = 'OV-CLOCK-UUID', SLOTS = ['OV-SLOT-0', 'OV-SLOT-1'];

function httpPost(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d || '{}'))); });
    r.on('error', reject); r.write(data); r.end();
  });
}
function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d || '{}'))); }).on('error', reject);
  });
}

const INFRA_DDL = `
  CREATE TABLE schema_version (version INTEGER NOT NULL);
  CREATE TABLE client_identity (id INTEGER PRIMARY KEY CHECK (id = 1), client_id TEXT NOT NULL, created_at TEXT NOT NULL, label TEXT);
  CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE mutations (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL, station_id TEXT, actor_id TEXT, table_name TEXT NOT NULL,
    row_id TEXT NOT NULL, op TEXT NOT NULL, payload_before TEXT, payload_after TEXT, created_at TEXT NOT NULL,
    applied_at TEXT NOT NULL, hlc TEXT NOT NULL, parent_mutation_id TEXT, schema_version INTEGER NOT NULL,
    origin TEXT NOT NULL, sync_status TEXT NOT NULL, conflict_resolution TEXT);
  CREATE TABLE quarantine_mutations (id TEXT PRIMARY KEY, raw_json TEXT NOT NULL, foreign_schema_version INTEGER NOT NULL,
    local_schema_version INTEGER NOT NULL, received_at TEXT NOT NULL, drain_status TEXT NOT NULL DEFAULT 'pending',
    retry_count INTEGER NOT NULL DEFAULT 0, retry_after TEXT);
`;
function syncedTableDDL(name) {
  const cols = { ...REGISTRY[name].columns };
  if (name === 'clock_slots') cols.song_id = 'scalar';
  const INT = /(^id$|_id$|^position$|^priority$|^spins_per_hour$|^duration_min$|^is_active$|_bitrate$|_port$)/;
  const defs = Object.keys(cols).map(c => c === 'id' ? 'id INTEGER PRIMARY KEY AUTOINCREMENT'
    : c === 'uuid' ? 'uuid TEXT NOT NULL UNIQUE' : `${c} ${INT.test(c) ? 'INTEGER' : 'TEXT'}`);
  return `CREATE TABLE ${name} (${defs.join(', ')});`;
}
const SYNCED_DDL = ['stations', 'categories', 'clocks', 'clock_slots'].map(syncedTableDDL).join('\n');

function makeInstall(label) {
  const db = new Database(':memory:');
  db.exec(INFRA_DDL); db.exec(SYNCED_DDL);
  const clientId = require('crypto').randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SV);
  db.prepare('INSERT INTO client_identity (id, client_id, created_at, label) VALUES (1, ?, ?, ?)').run(clientId, now, label);
  db.prepare("INSERT INTO system_state (key, value, updated_at) VALUES ('hlc_last', ?, ?)").run(`0:0:${clientId}`, now);
  return { db, merge: new MergeEngine(db, { localSchemaVersion: SV, causalQueue: new CausalOrderQueue(), onCursorAdvance: () => {} }), clientId, label };
}
function station(inst, uuid, name) {
  return stationsCreate(inst.db, { uuid, name, callsign: '', frequency: '', city: '', state: '', country: 'US',
    website: '', is_active: 0, icecast_server_url: '', icecast_mount: '', icecast_password: '', icecast_bitrate: 128, icecast_format: 'mp3' });
}
function buildOvProgramming(inst) {
  const st = station(inst, OV_UUID, 'OV');
  const cat = categoriesCreate(inst.db, { uuid: CAT_UUID, code: 'PG', name: 'Power Gold', color: '#fff', spins_per_hour: 4, priority: 1, station_id: st.id });
  const clock = clocksCreate(inst.db, { uuid: CLOCK_UUID, name: 'Afternoon Drive', show_id: null, description: '', color: '#000', station_id: st.id });
  SLOTS.forEach((u, i) => clockSlotsCreate(inst.db, { uuid: u, clock_id: clock.id, position: i, slot_type: 'category', category_id: cat.id, song_id: null, label: `slot${i}`, duration_min: 3, spot_type: null, station_id: st.id }));
  return st;
}
function pushPending(inst, port, client) {
  const pending = inst.db.prepare("SELECT * FROM mutations WHERE sync_status = 'pending' ORDER BY hlc ASC").all();
  inst.db.prepare("UPDATE mutations SET sync_status='synced' WHERE sync_status='pending'").run();
  return httpPost(port, '/sync/mutations', { client_id: client, station_id: null, batch: pending.map(toWireFormat) });
}
const get = (db, t, uuid) => db.prepare(`SELECT * FROM ${t} WHERE uuid = ?`).get(uuid);
const checks = []; const pass = (l, ok, d) => { checks.push(ok); console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${l}${d ? `  (${d})` : ''}`); };

(async () => {
  const pg = newDb();
  pg.public.none(`CREATE TABLE licenses (id SERIAL PRIMARY KEY, email TEXT)`);
  pg.public.none(`CREATE TABLE mutations (server_seq BIGSERIAL PRIMARY KEY, id TEXT, client_id TEXT, station_id TEXT, operator_id TEXT,
    license_key_id INTEGER, table_name TEXT, row_id TEXT, op TEXT, payload_before JSONB, payload_after JSONB, created_at TIMESTAMPTZ,
    hlc TEXT, parent_mutation_id TEXT, schema_version INTEGER, conflict_resolution JSONB, CONSTRAINT u UNIQUE (license_key_id, id))`);
  pg.public.none(`CREATE TABLE library_grants (id SERIAL PRIMARY KEY, owner_license_id INTEGER, grantee_license_id INTEGER, created_at TIMESTAMPTZ DEFAULT NOW(), revoked_at TIMESTAMPTZ)`);
  const { Pool } = pg.adapters.createPg(); const pool = new Pool();
  await pool.query(`INSERT INTO licenses (id, email) VALUES (1,'ov-account')`);
  const app = express(); app.use(express.json());
  app.use((r, _res, next) => { r.license = { id: OV_ACCOUNT }; next(); });  // member pull re-scopes to OV account (works)
  app.use('/sync', makeSyncRouter(pool));
  const server = app.listen(0); const port = server.address().port;

  // OV machine authors OV programming and pushes it to the account hub.
  const OV = makeInstall('OV-machine');
  const ovSt = buildOvProgramming(OV);
  await pushPending(OV, port, OV.clientId);
  console.log(`=== OV authored its programming: OV is local id ${ovSt.id} on the OV machine; clocks/slots tagged station_id=${ovSt.id}\n`);

  // djdeniro's REAL desktop: the DJ station is ALREADY here (local id 1).
  const DJ = makeInstall('djdeniro-desktop');
  const djSt = station(DJ, DJ_UUID, 'DJ Deniro');
  clocksCreate(DJ.db, { uuid: 'DJ-OWN-CLOCK', name: 'DJ show', show_id: null, description: '', color: '#111', station_id: djSt.id });
  console.log(`=== djdeniro desktop already has the DJ station at local id ${djSt.id}\n`);

  console.log('=== djdeniro (member of OV account) pulls OV programming ===');
  // Step 1: install-scope pull brings the OV station row down (stations push with station_id NULL).
  for (const m of ((await httpGet(port, `/sync/mutations?client_id=${DJ.clientId}&since_seq=0`)).mutations || [])) DJ.merge.apply(m);
  const djOv = get(DJ.db, 'stations', OV_UUID);
  pass('djdeniro received the OV station row', !!djOv, djOv && `OV local id on djdeniro = ${djOv.id} (DJ already holds id 1)`);

  // Step 2: now djdeniro pulls OV's station-scoped programming with ITS OWN local OV id (what getActiveStationId returns).
  const prog = await httpGet(port, `/sync/mutations?client_id=${DJ.clientId}&station_id=${djOv ? djOv.id : 2}&since_seq=0`);
  for (const m of (prog.mutations || [])) DJ.merge.apply(m);
  const delivered = (prog.mutations || []).filter(m => m.table_name !== 'stations').map(m => `${m.table_name}#${m.row_id.slice(-1)}(sid=${m.station_id})`);
  const djClocks = DJ.db.prepare('SELECT COUNT(*) n FROM clocks WHERE uuid = ?').get(CLOCK_UUID).n;
  const djSlots = DJ.db.prepare('SELECT COUNT(*) n FROM clock_slots WHERE uuid IN (?,?)').get(...SLOTS).n;
  console.log(`   programming rows the scoped pull delivered: [${delivered.join(', ') || 'NONE'}]`);
  pass('OV programming ARRIVES on djdeniro (clock + slots present)', djClocks === 1 && djSlots === 2,
    `clocks=${djClocks} slots=${djSlots} — djdeniro pulled scoped by station_id=${djOv ? djOv.id : 2}, OV tagged it station_id=${ovSt.id}`);

  // CONTROL: what if a path DID deliver OV's clock to djdeniro without UUID remap? It carries
  // station_id=1, which on djdeniro is the DJ station — so it would attach to the WRONG station.
  const ovClockMut = (await httpGet(port, `/sync/mutations?client_id=probe&station_id=${ovSt.id}&since_seq=0`)).mutations.find(m => m.table_name === 'clocks');
  DJ.merge.apply(ovClockMut);
  const contaminated = get(DJ.db, 'clocks', CLOCK_UUID);
  console.log('\n=== CONTROL: force-apply OV clock to djdeniro (no UUID remap) ===');
  console.log(`   OV clock now on djdeniro with station_id=${contaminated ? contaminated.station_id : 'n/a'}` +
    `  → that local id is the ${contaminated && contaminated.station_id === djSt.id ? 'DJ station (CONTAMINATION)' : 'OV station'}`);

  server.close();
  console.log('\n=== RESULT ===');
  const arrived = checks[checks.length - 1];
  if (arrived) {
    console.log('   OV programming ARRIVES on djdeniro\'s divergent install ✅');
    process.exit(0);
  } else {
    console.log('   OV programming SILENTLY MISSES on djdeniro\'s divergent install ❌');
    console.log('   djdeniro gets the OV station row but ZERO of its clocks/slots/categories: the station-');
    console.log(`   scoped pull asks for station_id=${djOv ? djOv.id : 2} (djdeniro's local OV id) while OV tagged`);
    console.log(`   the programming station_id=${ovSt.id} (OV's machine local id). No match, no error, no data.`);
    console.log('   And per CONTROL, any path that DID deliver it without UUID remap would attach OV\'s');
    console.log('   programming to djdeniro\'s DJ station (both are local id 1) — corruption, not delivery.');
    process.exit(1);
  }
})().catch(e => { console.error('PROOF HARNESS ERROR:', e); process.exit(2); });
