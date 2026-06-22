'use strict';
// scripts/prove-single-account-baseline.js
//
// BASELINE MEASUREMENT (read-only against current code — changes NOTHING in the sync core).
//
// Question: is the single-account, two-machine programming sync that OV depends on TODAY
// actually clean, or only clean by coincidence of local integer-id alignment?
//
// It drives the REAL code end-to-end for ONE account (one license):
//   • REAL handlers (clocks/clock_slots/categories/stations) generate the mutations exactly as
//     the app does — withMutation, real HLC, real payloads.
//   • REAL backend makeSyncRouter (pg-mem) is the push/pull hub (the station_id-scoped pull).
//   • REAL openair MergeEngine applies on the receiving machine (autoincrement + INSERT OR REPLACE).
//
// It builds full programming on machine A (station → category → clock → 2 clock_slots, where a
// slot references its clock and category by LOCAL INTEGER FK) and syncs it to machine B in two
// scenarios:
//   TEST 1  B is FRESH/empty (OV is its first station) — the lucky case where both machines
//           autoincrement ids in the same order.
//   TEST 1b convergence: A and B both edit the clock; do they converge (single account)?
//   TEST 2  B already has its OWN station first, so OV lands on a DIFFERENT local id — the case
//           a real second machine hits.
//
// Run:  ELECTRON_RUN_AS_NODE=1 OPENAIR_DIR=/c/openair \
//       /c/openair/node_modules/electron/dist/electron.exe scripts/prove-single-account-baseline.js

const path = require('path');
const http = require('http');
const express = require('express');
const { newDb } = require('pg-mem');

process.env.SYNC_SERVER_ID = process.env.SYNC_SERVER_ID || 'prove-single-account-baseline';
const makeSyncRouter = require('../src/routes/sync');

const OPENAIR = process.env.OPENAIR_DIR || 'C:/openair';
const req = (p) => require(path.join(OPENAIR, p));
const Database          = req('node_modules/better-sqlite3');
const uuidv4 = () => require('crypto').randomUUID();
const { MergeEngine }     = req('electron/sync/merge-engine');
const { CausalOrderQueue } = req('electron/sync/causal-order');
const { REGISTRY }         = req('electron/sync/synced-tables');
const { toWireFormat }     = req('electron/sync/mutation-writer');
const { stationsCreate }   = req('electron/sync/handlers/stations');
const { categoriesCreate } = req('electron/sync/handlers/categories');
const { clocksCreate, clocksUpdate } = req('electron/sync/handlers/clocks');
const { clockSlotsCreate } = req('electron/sync/handlers/clock_slots');

const SV = 16;
const ACCOUNT_LICENSE = 1;
const OV_UUID = 'OV-STATION-UUID', CAT_UUID = 'OV-CAT-UUID', CLOCK_UUID = 'OV-CLOCK-UUID';
const SLOTS = ['OV-SLOT-0', 'OV-SLOT-1'];

// ── HTTP helpers ───────────────────────────────────────────────────────────────
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
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d || '{}')));
    }).on('error', reject);
  });
}

// ── A faithful local install: real infra schema + the 4 live tables + a MergeEngine ──
const INFRA_DDL = `
  CREATE TABLE schema_version (version INTEGER NOT NULL);
  CREATE TABLE client_identity (id INTEGER PRIMARY KEY CHECK (id = 1), client_id TEXT NOT NULL, created_at TEXT NOT NULL, label TEXT);
  CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE mutations (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL, station_id TEXT, actor_id TEXT,
    table_name TEXT NOT NULL, row_id TEXT NOT NULL, op TEXT NOT NULL,
    payload_before TEXT, payload_after TEXT, created_at TEXT NOT NULL, applied_at TEXT NOT NULL,
    hlc TEXT NOT NULL, parent_mutation_id TEXT, schema_version INTEGER NOT NULL,
    origin TEXT NOT NULL, sync_status TEXT NOT NULL, conflict_resolution TEXT
  );
  CREATE TABLE quarantine_mutations (
    id TEXT PRIMARY KEY, raw_json TEXT NOT NULL, foreign_schema_version INTEGER NOT NULL,
    local_schema_version INTEGER NOT NULL, received_at TEXT NOT NULL,
    drain_status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0, retry_after TEXT
  );
`;
// Generate each live table straight from the REAL REGISTRY so every synced column exists with
// the right integer/text affinity (serializePayload fills missing scalars with null, so a missing
// column = an INSERT error). song_id is a clock_slots column the handler writes but the registry
// omits, so add it explicitly.
function syncedTableDDL(name) {
  const cols = { ...REGISTRY[name].columns };
  if (name === 'clock_slots') cols.song_id = 'scalar';
  const INT = /(^id$|_id$|^position$|^priority$|^spins_per_hour$|^duration_min$|^is_active$|_bitrate$|_port$)/;
  const defs = Object.keys(cols).map(c => {
    if (c === 'id')   return 'id INTEGER PRIMARY KEY AUTOINCREMENT';
    if (c === 'uuid') return 'uuid TEXT NOT NULL UNIQUE';
    return `${c} ${INT.test(c) ? 'INTEGER' : 'TEXT'}`;
  });
  return `CREATE TABLE ${name} (${defs.join(', ')});`;
}
const SYNCED_DDL = ['stations', 'categories', 'clocks', 'clock_slots'].map(syncedTableDDL).join('\n');

function makeInstall(label) {
  const db = new Database(':memory:');
  db.exec(INFRA_DDL);
  db.exec(SYNCED_DDL);
  const clientId = uuidv4();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SV);
  db.prepare('INSERT INTO client_identity (id, client_id, created_at, label) VALUES (1, ?, ?, ?)').run(clientId, now, label);
  db.prepare("INSERT INTO system_state (key, value, updated_at) VALUES ('hlc_last', ?, ?)").run(`0:0:${clientId}`, now);
  const merge = new MergeEngine(db, { localSchemaVersion: SV, causalQueue: new CausalOrderQueue(), onCursorAdvance: () => {} });
  return { db, merge, clientId, label };
}

// Build full station programming on an install via the REAL handlers. Returns the uuids + ids.
function buildProgramming(inst, { stationUuid, name, catUuid, clockUuid, slotUuids }) {
  const st = stationsCreate(inst.db, {
    uuid: stationUuid, name, callsign: '', frequency: '', city: '', state: '', country: 'US',
    website: '', is_active: 0, icecast_server_url: '', icecast_mount: '', icecast_password: '',
    icecast_bitrate: 128, icecast_format: 'mp3',
  });
  const cat = categoriesCreate(inst.db, {
    uuid: catUuid, code: 'PG', name: 'Power Gold', color: '#fff', spins_per_hour: 4, priority: 1, station_id: st.id,
  });
  const clock = clocksCreate(inst.db, {
    uuid: clockUuid, name: 'Afternoon Drive', show_id: null, description: '', color: '#000', station_id: st.id,
  });
  const slots = slotUuids.map((u, i) => clockSlotsCreate(inst.db, {
    uuid: u, clock_id: clock.id, position: i, slot_type: 'category', category_id: cat.id,
    song_id: null, label: `slot${i}`, duration_min: 3, spot_type: null, station_id: st.id,
  }));
  return { st, cat, clock, slots };
}

// A clock rename as a DISTINCT machine would emit it — explicit client_id + HLC, sidestepping the
// module-level getClientId() cache that collapses two in-process installs onto one identity.
// (Real machines are separate processes, each with its own client_id; this restores that.)
function makeClockUpdate(inst, { name, clientId, hlc, mutId }) {
  const cur = inst.db.prepare(`SELECT * FROM clocks WHERE uuid = ?`).get(CLOCK_UUID);
  const after = { id: cur.id, name, show_id: cur.show_id, description: cur.description, color: cur.color,
    station_id: cur.station_id, uuid: CLOCK_UUID, created_at: cur.created_at, updated_at: '2026-06-22T02:00:00.000Z', deleted_at: null };
  inst.db.prepare(`UPDATE clocks SET name = ?, updated_at = ? WHERE uuid = ?`).run(name, after.updated_at, CLOCK_UUID);
  inst.db.prepare(`INSERT INTO mutations (id, client_id, station_id, actor_id, table_name, row_id, op,
      payload_before, payload_after, created_at, applied_at, hlc, parent_mutation_id, schema_version, origin, sync_status, conflict_resolution)
    VALUES (?,?,?,?, 'clocks', ?, 'update', NULL, ?, ?, ?, ?, NULL, ?, 'local', 'synced', NULL)`)
    .run(mutId, clientId, String(cur.station_id), null, CLOCK_UUID, JSON.stringify(after), after.updated_at, after.updated_at, hlc, SV);
  return { id: mutId, client_id: clientId, station_id: String(cur.station_id), operator_id: null,
    table_name: 'clocks', row_id: CLOCK_UUID, op: 'update', payload_before: null, payload_after: after,
    created_at: after.updated_at, hlc, parent_mutation_id: null, schema_version: SV, conflict_resolution: null };
}

function pushPending(inst, port) {
  const pending = inst.db.prepare("SELECT * FROM mutations WHERE sync_status = 'pending' ORDER BY hlc ASC").all();
  const batch = pending.map(toWireFormat);
  inst.db.prepare("UPDATE mutations SET sync_status = 'synced' WHERE sync_status = 'pending'").run();
  return { batch, count: pending.length };
}

const get = (db, table, uuid) => db.prepare(`SELECT * FROM ${table} WHERE uuid = ?`).get(uuid);
const checks = [];
const pass = (label, ok, detail) => { checks.push({ label, ok: !!ok }); console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`); };

(async () => {
  // Backend hub
  const pg = newDb();
  pg.public.none(`CREATE TABLE licenses (id SERIAL PRIMARY KEY, email TEXT)`);
  pg.public.none(`
    CREATE TABLE mutations (
      server_seq BIGSERIAL PRIMARY KEY, id TEXT, client_id TEXT, station_id TEXT, operator_id TEXT,
      license_key_id INTEGER, table_name TEXT, row_id TEXT, op TEXT, payload_before JSONB, payload_after JSONB,
      created_at TIMESTAMPTZ, hlc TEXT, parent_mutation_id TEXT, schema_version INTEGER, conflict_resolution JSONB,
      station_uuid TEXT, ref_uuids JSONB,
      CONSTRAINT mutations_lic_id UNIQUE (license_key_id, id))`);
  pg.public.none(`CREATE TABLE library_grants (id SERIAL PRIMARY KEY, owner_license_id INTEGER NOT NULL, grantee_license_id INTEGER NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), revoked_at TIMESTAMPTZ)`);
  const { Pool } = pg.adapters.createPg();
  const pool = new Pool();
  await pool.query(`INSERT INTO licenses (id, email) VALUES (1,'ov-account')`);
  const app = express();
  app.use(express.json());
  app.use((r, _res, next) => { r.license = { id: ACCOUNT_LICENSE }; next(); });   // one account, both machines
  app.use('/sync', makeSyncRouter(pool));
  const server = app.listen(0);
  const port = server.address().port;

  // ── Machine A: author OV's programming, push it up ───────────────────────────
  const A = makeInstall('machine-A');
  const aProg = buildProgramming(A, { stationUuid: OV_UUID, name: 'OV', catUuid: CAT_UUID, clockUuid: CLOCK_UUID, slotUuids: SLOTS });
  const aPush = pushPending(A, port);
  await httpPost(port, '/sync/mutations', { client_id: A.clientId, station_id: null, batch: aPush.batch });
  console.log(`=== Machine A authored OV: station id=${aProg.st.id}, category id=${aProg.cat.id}, clock id=${aProg.clock.id}, slots clock_id=${aProg.slots[0].clock_id} category_id=${aProg.slots[0].category_id}`);
  console.log(`    pushed ${aPush.count} mutations to the account hub\n`);

  // ── TEST 1: FRESH machine B (OV is its first station) ────────────────────────
  console.log('=== TEST 1 — fresh machine B (empty), pulls OV ===');
  const B = makeInstall('machine-B');
  // B resolves its active OV station id by pulling install-scope first (station row has station_id NULL).
  // Realistically B then pulls station-scoped with ITS OWN local OV id. We pull once with the id B will
  // assign (fresh+empty → 1), which mirrors the real getActiveStationId() once the station is applied.
  let bPull = await httpGet(port, `/sync/mutations?client_id=${B.clientId}&station_id=1&since_seq=0`);
  for (const m of (bPull.mutations || [])) B.merge.apply(m);
  const bSt = get(B.db, 'stations', OV_UUID), bCat = get(B.db, 'categories', CAT_UUID), bClock = get(B.db, 'clocks', CLOCK_UUID);
  const bSlots = SLOTS.map(u => get(B.db, 'clock_slots', u)).filter(Boolean);
  pass('B received the OV station', !!bSt, bSt && `local id=${bSt.id}`);
  pass('B received the category', !!bCat, bCat && `local id=${bCat.id}`);
  pass('B received the clock', !!bClock, bClock && `local id=${bClock.id}`);
  pass('B received both clock_slots', bSlots.length === 2, `${bSlots.length}/2`);
  if (bClock && bSlots.length === 2) {
    pass('slot.clock_id on B points at B\'s OWN clock (parent FK linkage holds)',
      bSlots.every(s => s.clock_id === bClock.id), `slot.clock_id=${bSlots[0].clock_id} vs B clock id=${bClock.id}`);
  }
  if (bCat && bSlots.length === 2) {
    pass('slot.category_id on B points at B\'s OWN category (FK linkage holds)',
      bSlots.every(s => s.category_id === bCat.id), `slot.category_id=${bSlots[0].category_id} vs B cat id=${bCat.id}`);
  }
  if (bSt && bClock) pass('clock.station_id on B points at B\'s OWN station', bClock.station_id === bSt.id, `clock.station_id=${bClock.station_id} vs B station id=${bSt.id}`);

  // ── TEST 1b: concurrent edit convergence, single account, aligned ids ─────────
  console.log('\n=== TEST 1b — A and B both rename the clock concurrently, sync both ways ===');
  const aEdit = makeClockUpdate(A, { name: 'A: Drive', clientId: 'A-edit-client', hlc: '1900000000000:0:A-edit-client', mutId: 'edit-A' });
  const bEdit = makeClockUpdate(B, { name: 'B: Drive', clientId: 'B-edit-client', hlc: '1900000001000:0:B-edit-client', mutId: 'edit-B' });  // higher HLC → B wins
  await httpPost(port, '/sync/mutations', { client_id: 'A-edit-client', station_id: null, batch: [aEdit] });
  await httpPost(port, '/sync/mutations', { client_id: 'B-edit-client', station_id: null, batch: [bEdit] });
  A.merge.apply(bEdit);   // A receives B's edit (delivered: same local station id 1 on both)
  B.merge.apply(aEdit);   // B receives A's edit
  const aName = get(A.db, 'clocks', CLOCK_UUID).name, bName = get(B.db, 'clocks', CLOCK_UUID).name;
  pass('A and B converge to one clock name (LWW winner = B)', aName === bName && bName === 'B: Drive', `A="${aName}" B="${bName}"`);

  // ── TEST 2: machine B2 that already has its OWN station first ─────────────────
  console.log('\n=== TEST 2 — machine B2 already has its own station (OV lands on a DIFFERENT local id) ===');
  const B2 = makeInstall('machine-B2');
  buildProgramming(B2, { stationUuid: 'B2-OWN-STATION', name: 'KXXX (B2 own)', catUuid: 'B2-OWN-CAT', clockUuid: 'B2-OWN-CLOCK', slotUuids: ['B2-OWN-S0'] });
  pushPending(B2, port);   // B2's own writes stay local to B2 (not relevant to OV delivery)
  // B2 applies OV: the station row (station_id NULL) arrives; OV autoincrements to a NEW local id on B2.
  // B2's real getActiveStationId() for OV would then be that new id — pull OV programming scoped by it.
  for (const m of ((await httpGet(port, `/sync/mutations?client_id=${B2.clientId}&station_id=__install__&since_seq=0`)).mutations || [])) B2.merge.apply(m);
  const b2OV = get(B2.db, 'stations', OV_UUID);
  pass('B2 received the OV station row', !!b2OV, b2OV && `OV local id on B2 = ${b2OV.id} (NOT 1 — B2 already had a station)`);
  // Now pull OV's station-scoped programming with B2's ACTUAL local OV id:
  const b2Prog = await httpGet(port, `/sync/mutations?client_id=${B2.clientId}&station_id=${b2OV ? b2OV.id : 2}&since_seq=0`);
  for (const m of (b2Prog.mutations || [])) B2.merge.apply(m);
  const b2Clocks = B2.db.prepare('SELECT COUNT(*) n FROM clocks WHERE uuid = ?').get(CLOCK_UUID).n;
  const b2Slots  = B2.db.prepare('SELECT COUNT(*) n FROM clock_slots WHERE uuid IN (?,?)').get(...SLOTS).n;
  pass('OV programming ARRIVED at B2 (clock present)', b2Clocks === 1,
    `clocks=${b2Clocks} slots=${b2Slots} — pulled scoped by station_id=${b2OV ? b2OV.id : '2'}, but A tagged it station_id=${aProg.st.id}`);

  server.close();

  // ── Verdict ──────────────────────────────────────────────────────────────────
  const t1Clean = checks.slice(0, 8).every(c => c.ok);          // TEST 1 + 1b linkage/convergence
  const t2Broke = !checks[checks.length - 1].ok;                // TEST 2 non-delivery
  console.log('\n=== BASELINE VERDICT ===');
  if (t1Clean && t2Broke) {
    console.log('   Single-account two-machine sync is CLEAN **only when the two machines autoincrement');
    console.log('   local ids in the same order** (fresh/empty B, OV first). It is NOT robust: the moment');
    console.log('   a second machine already has a station (so OV gets a different local id), the station-');
    console.log('   scoped pull no longer matches and the programming does NOT arrive. Today\'s "it works"');
    console.log('   rests on coincidental integer-id alignment, not on reconciliation by UUID.');
    console.log('   => Confirms the Tier-2 fix is needed; the aligned case is what masks it in the field.');
  } else if (t1Clean && !t2Broke) {
    console.log('   Both the aligned AND the divergent-id cases delivered. Single-account sync is more robust');
    console.log('   than hypothesized — re-examine the model before assuming the integer-id fragility.');
  } else {
    console.log('   The ALIGNED case itself is not clean — single-account two-machine sync is broken even in');
    console.log('   the simple path. This is a bigger finding than expected; investigate before any fix.');
  }
  const allExpected = t1Clean;  // proof "passes" if the simple path OV relies on is at least clean
  console.log(`\n=== RESULT: ${allExpected ? 'baseline characterised; aligned path clean ✅' : 'aligned path NOT clean ❌'} ===`);
  process.exit(allExpected ? 0 : 1);
})().catch(e => { console.error('PROOF HARNESS ERROR:', e); process.exit(2); });
