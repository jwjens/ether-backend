'use strict';
// scripts/prove-member-convergence.js
//
// THE convergence proof that was supposed to come BEFORE the Plan-A gate change
// (member PUSH through one pipeline). It tests the real, hard claim:
//
//   "jensj (owner) and djdeniro (member) make CONCURRENT live-programming edits to the
//    SAME OV station and converge to ONE result — including reconciling their DIFFERENT
//    local station IDs."
//
// It drives the REAL code on BOTH ends — no mock of the thing under test:
//   • backend hub  = the REAL makeSyncRouter (src/routes/sync.js) on an in-memory
//                    Postgres (pg-mem). This is where push lands and where the
//                    station-scoped pull query lives.
//   • two installs = the REAL openair MergeEngine (C:\openair\electron\sync\merge-engine.js)
//                    on two better-sqlite3 DBs (owner + member), each with its OWN local
//                    integer station_id for the same OV station (same uuid).
//
// The gate is modelled as ON: both owner and member are authorised to the ACCOUNT
// (license_key_id = 1) and both PUSH through the identical pipeline — i.e. exactly the
// world the stashed gate change would create. The question this proves is NOT "is auth
// wired up" but "does the DATA actually converge once both can write."
//
// Run:  node scripts/prove-member-convergence.js
//       (requires: ether-backend has pg-mem; C:\openair has better-sqlite3 + the sync engine)

const path = require('path');
const http = require('http');
const express = require('express');
const { newDb } = require('pg-mem');

// Real backend router under test.
process.env.SYNC_SERVER_ID = process.env.SYNC_SERVER_ID || 'prove-member-convergence';
const makeSyncRouter = require('../src/routes/sync');

// Real openair install-side merge engine (cross-repo, by absolute path).
const OPENAIR = process.env.OPENAIR_DIR || 'C:/openair';
const Database          = require(path.join(OPENAIR, 'node_modules', 'better-sqlite3'));
const { MergeEngine }     = require(path.join(OPENAIR, 'electron', 'sync', 'merge-engine'));
const { CausalOrderQueue } = require(path.join(OPENAIR, 'electron', 'sync', 'causal-order'));

const SV = 16;                              // schema version on both installs
const ACCOUNT_LICENSE = 1;                  // the OV account; both owner+member push here under the gate
const OV_UUID    = 'OV-STATION-UUID';       // the ONE OV station — same uuid on both installs
const CLOCK_UUID = 'CLOCK-AFTERNOON-UUID';  // the ONE live-programming row both edit
const OWNER_LOCAL_SID  = 1;                 // jensj's install: OV is local station id 1
const MEMBER_LOCAL_SID = 7;                 // djdeniro's install: OV is local station id 7  ← DIFFERENT

// ── HTTP helpers (talk to the real router exactly as a client would) ───────────
function httpPost(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d || '{}'))); }
    );
    req.on('error', reject); req.write(data); req.end();
  });
}
function httpGet(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d || '{}')));
    }).on('error', reject);
  });
}

// ── A local install: real SQLite schema + real MergeEngine ─────────────────────
function makeInstall(localSid, clockLocalId, baselineName) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE mutations (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, station_id TEXT, actor_id TEXT,
      table_name TEXT NOT NULL, row_id TEXT NOT NULL, op TEXT NOT NULL,
      payload_before TEXT, payload_after TEXT, created_at TEXT NOT NULL, applied_at TEXT NOT NULL,
      hlc TEXT NOT NULL, parent_mutation_id TEXT, schema_version INTEGER NOT NULL,
      origin TEXT NOT NULL, sync_status TEXT NOT NULL, conflict_resolution TEXT
    );
    CREATE TABLE stations (
      id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE, name TEXT, is_active INTEGER,
      created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE clocks (
      id INTEGER PRIMARY KEY, name TEXT, show_id INTEGER, description TEXT, color TEXT,
      station_id INTEGER, uuid TEXT NOT NULL UNIQUE, created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
  `);
  const now = '2026-06-22T00:00:00.000Z';
  db.prepare(`INSERT INTO stations (id, uuid, name, is_active, created_at, updated_at) VALUES (?,?,?,1,?,?)`)
    .run(localSid, OV_UUID, 'OV', now, now);
  db.prepare(`INSERT INTO clocks (id, name, station_id, uuid, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run(clockLocalId, baselineName, localSid, CLOCK_UUID, now, now);

  const merge = new MergeEngine(db, {
    localSchemaVersion: SV,
    causalQueue: new CausalOrderQueue(),
    onCursorAdvance: () => {},
  });
  return { db, merge, localSid, clockLocalId };
}

// Build the full clock row as it would sit in payload_after (every REGISTRY column present).
function clockRow(localSid, clockLocalId, name) {
  return {
    id: clockLocalId, name, show_id: null, description: null, color: null,
    station_id: localSid, uuid: CLOCK_UUID,
    created_at: '2026-06-22T00:00:00.000Z', updated_at: '2026-06-22T01:00:00.000Z', deleted_at: null,
  };
}

// One live-programming edit, as the real handler would log it locally AND as it goes on the wire.
function makeEdit({ install, clientId, name, hlc, mutId }) {
  const after = clockRow(install.localSid, install.clockLocalId, name);
  // (1) apply locally exactly as withMutation would: update the live row + log the local mutation
  //     (so the install's own LWW history is real for the merge that follows).
  install.db.prepare(`UPDATE clocks SET name = ?, updated_at = ? WHERE uuid = ?`)
    .run(name, after.updated_at, CLOCK_UUID);
  install.db.prepare(`
    INSERT INTO mutations (id, client_id, station_id, actor_id, table_name, row_id, op,
      payload_before, payload_after, created_at, applied_at, hlc, parent_mutation_id,
      schema_version, origin, sync_status, conflict_resolution)
    VALUES (?,?,?,?, 'clocks', ?, 'update', NULL, ?, ?, ?, ?, NULL, ?, 'local', 'pending', NULL)
  `).run(mutId, clientId, String(install.localSid), null, CLOCK_UUID,
         JSON.stringify(after), after.updated_at, after.updated_at, hlc, SV);
  // (2) the wire-format mutation this install pushes to the hub
  return {
    id: mutId, client_id: clientId, station_id: String(install.localSid), operator_id: null,
    table_name: 'clocks', row_id: CLOCK_UUID, op: 'update',
    payload_before: null, payload_after: after,
    created_at: after.updated_at, hlc, parent_mutation_id: null, schema_version: SV, conflict_resolution: null,
  };
}

(async () => {
  // ── Backend hub: pg-mem + the REAL router ────────────────────────────────────
  const pg = newDb();
  pg.public.none(`CREATE TABLE licenses (id SERIAL PRIMARY KEY, email TEXT)`);
  pg.public.none(`
    CREATE TABLE mutations (
      server_seq BIGSERIAL PRIMARY KEY,
      id TEXT, client_id TEXT, station_id TEXT, operator_id TEXT,
      license_key_id INTEGER, table_name TEXT, row_id TEXT, op TEXT,
      payload_before JSONB, payload_after JSONB, created_at TIMESTAMPTZ,
      hlc TEXT, parent_mutation_id TEXT, schema_version INTEGER, conflict_resolution JSONB,
      CONSTRAINT mutations_lic_id UNIQUE (license_key_id, id)
    )`);
  pg.public.none(`
    CREATE TABLE library_grants (
      id SERIAL PRIMARY KEY, owner_license_id INTEGER NOT NULL, grantee_license_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(), revoked_at TIMESTAMPTZ )`);
  const { Pool } = pg.adapters.createPg();
  const pool = new Pool();
  await pool.query(`INSERT INTO licenses (id, email) VALUES (1,'ov-account')`);

  const app = express();
  app.use(express.json());
  // The gate, modelled as ON: owner AND member both resolve to the ACCOUNT license (1) and are
  // authorised to PUSH. This is precisely the world the stashed gate change creates ("one pipeline,
  // login as the gate"). req.isMember is intentionally left unset so the POST handler accepts the
  // write — we are testing whether the DATA converges once both can write, not the auth wiring.
  app.use((req, _res, next) => { req.license = { id: ACCOUNT_LICENSE }; next(); });
  app.use('/sync', makeSyncRouter(pool));
  const server = app.listen(0);
  const port = server.address().port;

  // ── Two installs with DIFFERENT local station ids for the SAME OV station ─────
  const owner  = makeInstall(OWNER_LOCAL_SID,  100, 'Afternoon Drive');
  const member = makeInstall(MEMBER_LOCAL_SID, 200, 'Afternoon Drive');

  // ── Concurrent edits. Member's HLC is higher → member is the LWW winner; a correct
  //    convergence must leave BOTH installs showing the member's value. ───────────
  const OWNER_CLIENT = 'owner-client', MEMBER_CLIENT = 'member-client';
  const ownerEdit  = makeEdit({ install: owner,  clientId: OWNER_CLIENT,  name: "OWNER: Drive w/ Jeff",     hlc: '1000:0:owner-client',  mutId: 'mo' });
  const memberEdit = makeEdit({ install: member, clientId: MEMBER_CLIENT, name: "MEMBER: Drive w/ DJ Deniro", hlc: '2000:0:member-client', mutId: 'mm' });

  // ── PUSH both to the hub (both under the account license) ─────────────────────
  await httpPost(port, '/sync/mutations', { client_id: OWNER_CLIENT,  station_id: null, batch: [ownerEdit] });
  await httpPost(port, '/sync/mutations', { client_id: MEMBER_CLIENT, station_id: null, batch: [memberEdit] });

  const hubCount = (await pool.query(`SELECT COUNT(*)::int n FROM mutations`)).rows[0].n;

  // ── PULL back + MERGE, each install scoped by ITS OWN local station id ─────────
  const ownerPull  = await httpGet(port, `/sync/mutations?client_id=${OWNER_CLIENT}&station_id=${OWNER_LOCAL_SID}&since_seq=0`);
  for (const m of (ownerPull.mutations || [])) owner.merge.apply(m);

  const memberPull = await httpGet(port, `/sync/mutations?client_id=${MEMBER_CLIENT}&station_id=${MEMBER_LOCAL_SID}&since_seq=0`);
  for (const m of (memberPull.mutations || [])) member.merge.apply(m);

  server.close();

  const ownerName  = owner.db.prepare(`SELECT name FROM clocks WHERE uuid = ?`).get(CLOCK_UUID).name;
  const memberName = member.db.prepare(`SELECT name FROM clocks WHERE uuid = ?`).get(CLOCK_UUID).name;
  const ownerSees  = (ownerPull.mutations  || []).map(m => `${m.id}(sid=${m.station_id})`);
  const memberSees = (memberPull.mutations || []).map(m => `${m.id}(sid=${m.station_id})`);

  console.log('=== SETUP ===');
  console.log(`   OV station uuid = ${OV_UUID}`);
  console.log(`   owner  install: OV local station_id = ${OWNER_LOCAL_SID}`);
  console.log(`   member install: OV local station_id = ${MEMBER_LOCAL_SID}   (DIFFERENT — the reconciliation case)`);
  console.log(`   both PUSH to account license_key_id = ${ACCOUNT_LICENSE} (gate modelled ON)`);
  console.log(`   hub stored ${hubCount} mutations (expect 2)`);
  console.log('');
  console.log('=== END-TO-END (real router pull, scoped by each install\'s own station_id) ===');
  console.log(`   owner  pulled: [${ownerSees.join(', ')  || '∅'}]`);
  console.log(`   member pulled: [${memberSees.join(', ') || '∅'}]`);
  console.log(`   owner  clock name  = "${ownerName}"`);
  console.log(`   member clock name  = "${memberName}"`);
  const WINNER = "MEMBER: Drive w/ DJ Deniro";   // higher HLC
  const converged = ownerName === memberName && ownerName === WINNER;
  console.log(`   converged to the LWW winner on BOTH installs? ${converged ? 'YES' : 'NO'}`);
  console.log('');

  // ── CONTROL: feed member's edit DIRECTLY into owner's merge engine, bypassing the
  //    backend's station-scoped pull. Isolates WHERE convergence breaks. ──────────
  owner.merge.apply(memberEdit);
  const ownerNameForced = owner.db.prepare(`SELECT name FROM clocks WHERE uuid = ?`).get(CLOCK_UUID).name;
  const ownerSidForced  = owner.db.prepare(`SELECT station_id FROM clocks WHERE uuid = ?`).get(CLOCK_UUID).station_id;
  console.log('=== CONTROL: member edit fed straight to owner merge (no scoped pull) ===');
  console.log(`   owner clock name now      = "${ownerNameForced}"  (merge/LWW ${ownerNameForced === WINNER ? 'WORKS' : 'BROKEN'})`);
  console.log(`   owner clock station_id now = ${ownerSidForced}  (was ${OWNER_LOCAL_SID}; merge wrote the SENDER's local id ${MEMBER_LOCAL_SID})`);
  console.log('');

  console.log('=== RESULT ===');
  if (converged) {
    console.log('   CONVERGED ✅ — owner and member reached one result across different local station ids.');
    process.exit(0);
  } else {
    console.log('   NOT CONVERGED ❌ — concurrent owner/member edits did NOT reconcile.');
    console.log('   Diagnosis:');
    console.log('     1) The backend pull is scoped by the RECEIVER\'s local station_id');
    console.log('        (sync.js: WHERE station_id = $3 OR station_id IS NULL). Owner (sid=1) never');
    console.log('        receives member\'s station-scoped edit (sid=7), and vice-versa — their edits');
    console.log('        are partitioned by the local-id mismatch, so they cannot converge.');
    console.log('     2) Even when delivered (see CONTROL), the merge writes the SENDER\'s local');
    console.log('        station_id onto the row, detaching it from the receiver\'s own station.');
    console.log('   => The convergence claim is FALSE for different local station ids. The gate change');
    console.log('      must NOT be re-applied until the sync path reconciles station identity by UUID.');
    process.exit(1);
  }
})().catch(e => { console.error('PROOF HARNESS ERROR:', e); process.exit(2); });
