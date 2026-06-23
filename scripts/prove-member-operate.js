'use strict';
// scripts/prove-member-operate.js
//
// Proves the MEMBER-OPERATE build: a member (djdeniro, PD on OV) operates OV as a FULL station on his
// own desktop — edits sync BOTH ways — AND the per-station push isolation guarantees no cross-account
// contamination. Drives the REAL stack: REAL handlers → REAL SyncEngine.push/pull (uuidIdentity +
// the NEW per-context push filter) → REAL HttpTransport (member Bearer + per-context cursors) → REAL
// makeSyncRouter (pg-mem) → REAL MergeEngine. The /sync auth gate is reproduced FAITHFULLY here
// (JWT verify → active membership → edit_programming → whole-account scope → req.license={id:lk}) —
// the same decision the deployed requireLicenseOrMember makes, without booting the index.js monolith.
//
// Topology: TWO accounts. OV = license_key_id 1, DJ Deniro = license_key_id 2. djdeniro's desktop
// already holds his OWN DJ station (local id 1); OV lands on local id 2 there — the divergent case.
// His desktop runs TWO sync contexts on ONE db:
//   • owner context — x-license-key lk-dj → account 2; getPushExcludeStationIds = [OV local id]
//   • member context — Bearer member-token → account 1 (OV); getPushOnlyStationId = OV local id
//
// Run:  ELECTRON_RUN_AS_NODE=1 OPENAIR_DIR=/c/openair \
//       /c/openair/node_modules/electron/dist/electron.exe scripts/prove-member-operate.js

const path = require('path');
const express = require('express');
const { newDb } = require('pg-mem');
const jwt = require(path.join(__dirname, '..', 'node_modules', 'jsonwebtoken'));

process.env.SYNC_SERVER_ID = process.env.SYNC_SERVER_ID || 'prove-member-operate';
const makeSyncRouter = require('../src/routes/sync');

const OPENAIR = process.env.OPENAIR_DIR || 'C:/openair';
const req = (p) => require(path.join(OPENAIR, p));
const Database            = req('node_modules/better-sqlite3');
const { SyncEngine }       = req('electron/sync/sync-engine');
const { HttpTransport }    = req('electron/sync/transport-http');
const { REGISTRY }         = req('electron/sync/synced-tables');
const { stationsCreate }    = req('electron/sync/handlers/stations');
const { categoriesCreate }  = req('electron/sync/handlers/categories');
const { clocksCreate, clocksUpdate } = req('electron/sync/handlers/clocks');
const { clockSlotsCreate }  = req('electron/sync/handlers/clock_slots');

const SV = 16;
const OV_ACCT = 1, DJ_ACCT = 2;
const OV_UUID = 'OV-STATION-UUID', DJ_UUID = 'DJ-STATION-UUID';
const CAT_UUID = 'OV-CAT-UUID', CLOCK_UUID = 'OV-CLOCK-UUID', SLOTS = ['OV-SLOT-0', 'OV-SLOT-1'];
const DJ_OWN_CLOCK = 'DJ-OWN-CLOCK';
const JWT_SECRET = 'test-secret-member-operate';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// faithful reproduction of the deployed gate's authorization decision (no monolith boot)
const LICENSE_BY_KEY = { 'lk-OV-machine': OV_ACCT, 'lk-dj': DJ_ACCT };
const MEMBERSHIPS = { '7|1': { status: 'active', all_stations: true, permissions: { edit_programming: true } } };

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

function makeDb(label, licenseKey) {
  const db = new Database(':memory:');
  db.exec(INFRA_DDL); db.exec(SYNCED_DDL);
  const clientId = require('crypto').randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SV);
  db.prepare('INSERT INTO client_identity (id, client_id, created_at, label) VALUES (1, ?, ?, ?)').run(clientId, now, label);
  db.prepare("INSERT INTO system_state (key, value, updated_at) VALUES ('hlc_last', ?, ?)").run(`0:0:${clientId}`, now);
  db.prepare("INSERT INTO station_config_kv (station_id, key, value) VALUES (1,'license_key',?)").run(licenseKey);
  return { db, clientId, label };
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
  await pool.query(`INSERT INTO licenses (id, email) VALUES (1,'ov-account'),(2,'dj-account')`);

  const app = express(); app.use(express.json());
  // ── Faithful /sync gate: same decision as the deployed requireLicenseOrMember ──
  app.use((r, res, next) => {
    const lk = r.headers['x-license-key'];
    if (lk) { const id = LICENSE_BY_KEY[lk]; if (!id) return res.status(401).json({ error: 'bad_license' }); r.license = { id }; return next(); }
    const h = r.headers['authorization'] || '';
    if (h.startsWith('Bearer ')) {
      try {
        const p = jwt.verify(h.slice(7), JWT_SECRET);
        if ((p.typ === 'owner' || p.typ === 'user') && p.lk) {
          const m = MEMBERSHIPS[`${p.uid}|${p.lk}`];
          if (m && m.status === 'active') {
            if (!m.permissions || !m.permissions.edit_programming) return res.status(403).json({ error: 'member_edit_required' });
            // all_stations:true → whole-account scope satisfied
            r.license = { id: p.lk }; r.isMember = true; r.member = m; return next();
          }
        }
      } catch (_) { /* fall through */ }
    }
    return res.status(401).json({ error: 'license_key_required' });
  });
  app.use('/sync', makeSyncRouter(pool));
  const server = app.listen(0); const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const countMut = async (licenseId, rowId) =>
    Number((await pool.query('SELECT COUNT(*)::int n FROM mutations WHERE license_key_id = $1 AND row_id = $2', [licenseId, rowId])).rows[0].n);

  // ── OV machine authors OV programming and pushes (OV = local id 1 on the OV machine) ──
  const OV = makeDb('OV-machine', 'lk-OV-machine');
  const ovEngine = new SyncEngine(OV.db, new HttpTransport(OV.db, { baseUrl, licenseKey: 'lk-OV-machine' }), {
    localSchemaVersion: SV, uuidIdentity: true,
    getStationId:   () => { const s = get(OV.db, 'stations', OV_UUID); return s ? String(s.id) : null; },
    getStationUuid: () => OV_UUID,
  });
  const ovSt = station(OV.db, OV_UUID, 'OV');
  const ovCat = categoriesCreate(OV.db, { uuid: CAT_UUID, code: 'PG', name: 'Power Gold', color: '#fff', spins_per_hour: 4, priority: 1, station_id: ovSt.id });
  const ovClock = clocksCreate(OV.db, { uuid: CLOCK_UUID, name: 'Afternoon Drive', show_id: null, description: '', color: '#000', station_id: ovSt.id });
  SLOTS.forEach((u, i) => clockSlotsCreate(OV.db, { uuid: u, clock_id: ovClock.id, position: i, slot_type: 'category', category_id: ovCat.id, song_id: null, label: `slot${i}`, duration_min: 3, spot_type: null, station_id: ovSt.id }));
  await ovEngine.push();
  console.log(`=== OV authored programming (OV local id ${ovSt.id} on its machine), pushed to OV account\n`);

  // ── djdeniro's desktop: holds DJ station (local id 1) + two sync contexts ──
  const DJ = makeDb('djdeniro-desktop', 'lk-dj');
  const djSt = station(DJ.db, DJ_UUID, 'DJ Deniro');
  clocksCreate(DJ.db, { uuid: DJ_OWN_CLOCK, name: 'DJ show', show_id: null, description: '', color: '#111', station_id: djSt.id });
  DJ.db.prepare("UPDATE mutations SET sync_status='synced' WHERE sync_status='pending'").run();   // his own data already on his account
  const localId = (uuid) => { const r = DJ.db.prepare('SELECT id FROM stations WHERE uuid = ?').get(uuid); return r ? String(r.id) : null; };
  // member token = what POST /api/me/switch-account/:ovAccount mints for djdeniro (uid 7), scoped to OV
  const memberToken = jwt.sign({ typ: 'user', uid: 7, lk: OV_ACCT }, JWT_SECRET);

  const djOwner = new SyncEngine(DJ.db, new HttpTransport(DJ.db, { baseUrl, licenseKey: 'lk-dj' }), {
    localSchemaVersion: SV, uuidIdentity: true,
    getStationId:   () => localId(DJ_UUID),
    getStationUuid: () => DJ_UUID,
    getPushExcludeStationIds: () => [localId(OV_UUID)].filter(Boolean),   // never push OV's edits under the DJ license
  });
  const djMember = new SyncEngine(DJ.db, new HttpTransport(DJ.db, { baseUrl, memberToken, cursorKey: 'sync_server_seq_member' }), {
    localSchemaVersion: SV, uuidIdentity: true, cursorKey: 'sync_cursor_member',
    getStationId:   () => localId(OV_UUID),
    getStationUuid: () => OV_UUID,
    getPushOnlyStationId: () => localId(OV_UUID),                          // push ONLY OV's edits, under the member token
  });
  console.log(`=== djdeniro desktop holds DJ station at local id ${djSt.id}; member context authes as Bearer member to OV\n`);

  // ── DIRECTION 1 — member context pulls OV programming (through the real gate, member token) ──
  console.log('=== DIRECTION 1 — djdeniro pulls OV programming as a Bearer member ===');
  await djMember.pull();
  const djOv = get(DJ.db, 'stations', OV_UUID), djClock = get(DJ.db, 'clocks', CLOCK_UUID), djCat = get(DJ.db, 'categories', CAT_UUID);
  const djSlots = SLOTS.map(u => get(DJ.db, 'clock_slots', u)).filter(Boolean);
  pass('OV station arrived on djdeniro via member auth', !!djOv, djOv && `local id ${djOv.id} (≠1: DJ holds 1)`);
  pass('OV clock + both slots arrived', !!djClock && djSlots.length === 2, `clock=${!!djClock} slots=${djSlots.length}`);
  pass('clock.station_id remapped to djdeniro\'s OWN OV station', djClock && djOv && djClock.station_id === djOv.id, djClock && `=${djClock.station_id} vs ${djOv && djOv.id}`);
  pass('slot.clock_id + category_id remapped to djdeniro\'s locals', djSlots.length === 2 && djClock && djCat && djSlots.every(s => s.clock_id === djClock.id && s.category_id === djCat.id));

  // ── DIRECTION 2a — OV edits, djdeniro (member) sees it ──
  console.log('\n=== DIRECTION 2a — OV edits clock, member pulls ===');
  await sleep(8);
  clocksUpdate(OV.db, CLOCK_UUID, { name: 'OV edit: Drive w/ Jeff' });
  await ovEngine.push();
  await djMember.pull();
  pass('djdeniro sees OV\'s edit', get(DJ.db, 'clocks', CLOCK_UUID).name === 'OV edit: Drive w/ Jeff', `"${get(DJ.db, 'clocks', CLOCK_UUID).name}"`);

  // ── DIRECTION 2b — djdeniro edits OV, OV sees it (member PUSH under the gate) ──
  console.log('\n=== DIRECTION 2b — djdeniro edits OV clock, member pushes, OV pulls ===');
  await sleep(8);
  clocksUpdate(DJ.db, CLOCK_UUID, { name: 'DJ edit: Drive w/ DJ Deniro' });
  await djMember.push();
  await ovEngine.pull();
  pass('OV sees djdeniro\'s edit (member push accepted by gate)', get(OV.db, 'clocks', CLOCK_UUID).name === 'DJ edit: Drive w/ DJ Deniro', `"${get(OV.db, 'clocks', CLOCK_UUID).name}"`);
  pass('OV clock still scoped to OV\'s local station 1', get(OV.db, 'clocks', CLOCK_UUID).station_id === ovSt.id, `=${get(OV.db, 'clocks', CLOCK_UUID).station_id}`);

  // ── PUSH ISOLATION — the core no-contamination guarantee ──
  console.log('\n=== PUSH ISOLATION — edits never cross accounts ===');
  await sleep(8);
  clocksUpdate(DJ.db, DJ_OWN_CLOCK, { name: 'DJ private: my own station' });   // edit on djdeniro's OWN station (station_id=1)
  await djMember.push();   // member context (getPushOnlyStationId=OV) must NOT carry the DJ-own edit
  await djOwner.push();    // owner context (exclude OV) must NOT carry the OV clock, but DOES carry DJ-own
  pass('OV account never received djdeniro\'s OWN-station clock', (await countMut(OV_ACCT, DJ_OWN_CLOCK)) === 0, `count=${await countMut(OV_ACCT, DJ_OWN_CLOCK)}`);
  pass('DJ account never received the OV clock', (await countMut(DJ_ACCT, CLOCK_UUID)) === 0, `count=${await countMut(DJ_ACCT, CLOCK_UUID)}`);
  pass('DJ account DID receive djdeniro\'s own-station clock', (await countMut(DJ_ACCT, DJ_OWN_CLOCK)) > 0, `count=${await countMut(DJ_ACCT, DJ_OWN_CLOCK)}`);
  pass('OV account holds djdeniro\'s OV edit (member push landed in OV)', (await countMut(OV_ACCT, CLOCK_UUID)) > 0, `count=${await countMut(OV_ACCT, CLOCK_UUID)}`);

  server.close();
  const ok = checks.every(Boolean);
  console.log(`\n=== RESULT: ${ok ? 'MEMBER-OPERATE bidirectional + push isolation PROVEN ✅' : 'FAIL ❌'} ===`);
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('PROOF HARNESS ERROR:', e); process.exit(2); });
