'use strict';
// scripts/prove-library-grant-isolation.js
//
// Proves the cross-license library-grant ISOLATION BOUNDARY in GET /sync/mutations.
// Runs the REAL makeSyncRouter (src/routes/sync.js) against an in-memory Postgres
// (pg-mem) — no production DB touched. Seeds an owner license, a grantee license, an
// unrelated license, one grant, and mutations spanning every row type; then pulls as
// the grantee and asserts ONLY the owner's songs/artists/albums cross the license line.
//
// Run:  node scripts/prove-library-grant-isolation.js   (requires: npm i pg-mem --no-save)

const { newDb } = require('pg-mem');
const express   = require('express');
const http      = require('http');
const makeSyncRouter = require('../src/routes/sync');

const OWNER = 1, GRANTEE = 2, UNRELATED = 3;
const GRANTEE_STATION = '20';

const db = newDb();
db.public.none(`CREATE TABLE licenses (id SERIAL PRIMARY KEY, email TEXT)`);
db.public.none(`
  CREATE TABLE mutations (
    server_seq BIGSERIAL PRIMARY KEY,
    id TEXT, client_id TEXT, station_id TEXT, operator_id TEXT,
    license_key_id INTEGER, table_name TEXT, row_id TEXT, op TEXT,
    payload_before JSONB, payload_after JSONB, created_at TIMESTAMPTZ,
    hlc TEXT, parent_mutation_id TEXT, schema_version INTEGER, conflict_resolution JSONB,
    station_uuid TEXT, ref_uuids JSONB
  )`);
db.public.none(`
  CREATE TABLE library_grants (
    id SERIAL PRIMARY KEY,
    owner_license_id INTEGER NOT NULL,
    grantee_license_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
  )`);

const { Pool } = db.adapters.createPg();
const pool = new Pool();

let seq = 0;
async function seed(lk, station_id, table_name) {
  seq += 1;
  await pool.query(
    `INSERT INTO mutations (id, client_id, station_id, operator_id, license_key_id,
       table_name, row_id, op, created_at, hlc, schema_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'insert',NOW(),$8,22)`,
    [`m${seq}`, 'cli', station_id, null, lk, table_name, `r${seq}`, `${seq}:0:cli`]
  );
  return `m${seq}`;
}

(async () => {
  await pool.query(`INSERT INTO licenses (id, email) VALUES (1,'owner'),(2,'grantee'),(3,'unrelated')`);

  // OWNER (lk=1) — the master catalog plus rows that MUST NOT cross the license line.
  const ownerExpect = [
    await seed(OWNER, null, 'songs'),
    await seed(OWNER, null, 'songs'),
    await seed(OWNER, null, 'artists'),
    await seed(OWNER, null, 'albums'),
  ];
  const ownerMustExclude = {
    'install_config_kv (owner install-scope config)': await seed(OWNER, null, 'install_config_kv'),
    'install_secrets_kv (owner secrets)':             await seed(OWNER, null, 'install_secrets_kv'),
    'clocks (owner station-scoped)':                  await seed(OWNER, '10', 'clocks'),
    'categories (owner station-scoped)':              await seed(OWNER, '10', 'categories'),
    'separation_rules (owner station-scoped)':        await seed(OWNER, '10', 'separation_rules'),
  };

  // GRANTEE (lk=2) — own rows must still arrive via the normal self-scope.
  const granteeSelfSong    = await seed(GRANTEE, null, 'songs');                 // self install-scope
  const granteeSelfClock20 = await seed(GRANTEE, GRANTEE_STATION, 'clocks');     // self, this station
  const granteeOtherClock  = await seed(GRANTEE, '99', 'clocks');               // self, OTHER station → excluded

  // UNRELATED (lk=3) — no grant; must never appear.
  const unrelatedSong = await seed(UNRELATED, null, 'songs');

  // The single grant under test: OWNER's library → GRANTEE (read-only).
  await pool.query(`INSERT INTO library_grants (owner_license_id, grantee_license_id) VALUES ($1,$2)`,
    [OWNER, GRANTEE]);

  // Mount the REAL router; middleware sets req.license = the grantee (as requireLicense would).
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.license = { id: GRANTEE }; next(); });
  app.use('/sync', makeSyncRouter(pool));
  const server = app.listen(0);
  const port = server.address().port;

  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/sync/mutations?client_id=cli&station_id=${GRANTEE_STATION}&since_seq=0`,
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); })
      .on('error', reject);
  });
  server.close();

  const got = body.mutations || [];
  const byId = new Map(got.map(m => [m.id, m]));
  // NOTE: the wire payload intentionally omits license_key_id (clients never learn which
  // license a row belongs to), so rows are identified here by id + table + station.
  const fmt = m => `station=${m.station_id == null ? 'NULL' : m.station_id}  ${m.table_name}`;

  console.log('=== WHAT THE GRANTEE PULL RETURNED (', got.length, 'rows ) ===');
  for (const m of got) console.log(`   ${m.id.padEnd(4)} ${fmt(m)}`);

  const checks = [];
  const pass = (label, cond) => checks.push({ label, ok: !!cond });

  // 1. Owner's library DID cross (read access works).
  for (const id of ownerExpect) pass(`owner library row ${id} (${byId.get(id)?.table_name}) delivered`, byId.has(id));
  // 2. Owner's NON-library rows did NOT cross (the boundary).
  for (const [label, id] of Object.entries(ownerMustExclude))
    pass(`owner ${label} EXCLUDED`, !byId.has(id));
  // 3. AIRTIGHT: the returned id set must equal the expected set EXACTLY — no extra row of
  //    any kind crossed, and nothing expected is missing. (Wire payload omits license_key_id,
  //    so this exact-set check, not a per-row license filter, is what proves no leak.)
  const expectedIds = new Set([...ownerExpect, granteeSelfSong, granteeSelfClock20]);
  const gotIds = new Set(got.map(m => m.id));
  const extra   = [...gotIds].filter(x => !expectedIds.has(x));
  const missing = [...expectedIds].filter(x => !gotIds.has(x));
  if (extra.length)   console.log('   !! UNEXPECTED rows crossed:', extra.map(id => `${id}(${byId.get(id)?.table_name})`).join(', '));
  if (missing.length) console.log('   !! MISSING expected rows:', missing.join(', '));
  pass('returned id set EXACTLY equals expected (no extra crossed, none missing)', extra.length === 0 && missing.length === 0);
  // 4. Grantee's own rows still arrive normally (self-scope intact).
  pass('grantee self install-scope song delivered', byId.has(granteeSelfSong));
  pass('grantee self station(20) clock delivered',  byId.has(granteeSelfClock20));
  pass('grantee OTHER-station(99) clock excluded',  !byId.has(granteeOtherClock));
  // 5. Unrelated license never appears (no grant).
  pass('unrelated license (no grant) song EXCLUDED', !byId.has(unrelatedSong));

  console.log('\n=== ISOLATION ASSERTIONS ===');
  let allOk = true;
  for (const c of checks) { console.log(`   ${c.ok ? 'PASS' : 'FAIL'}  ${c.label}`); if (!c.ok) allOk = false; }

  console.log('\n=== RESULT:', allOk ? 'BOUNDARY HOLDS — all assertions passed ✅' : 'BOUNDARY VIOLATED — see FAIL above ❌', '===');
  process.exit(allOk ? 0 : 1);
})().catch(e => { console.error('PROOF HARNESS ERROR:', e); process.exit(2); });
