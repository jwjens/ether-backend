'use strict';
// scripts/smoke-library-grants-crud.js
//
// Smoke-tests the SQL behind the platform library-grants CRUD endpoints against an in-memory
// Postgres (pg-mem) — create (upsert/un-revoke), list (join to grantee email), soft-revoke.
// No production DB touched.  Run:  node scripts/smoke-library-grants-crud.js

const { newDb } = require('pg-mem');

const db = newDb();
db.public.none(`CREATE TABLE licenses (id SERIAL PRIMARY KEY, email TEXT, plan TEXT)`);
db.public.none(`
  CREATE TABLE library_grants (
    id SERIAL PRIMARY KEY,
    owner_license_id INTEGER NOT NULL,
    grantee_license_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    UNIQUE (owner_license_id, grantee_license_id)
  )`);
const { Pool } = db.adapters.createPg();
const pool = new Pool();

const OWNER = 1, GRANTEE = 2;

// Endpoint SQL replicas (exact statements from src/index.js).
const create = (id, granteeId) => pool.query(
  `INSERT INTO library_grants (owner_license_id, grantee_license_id) VALUES ($1,$2)
   ON CONFLICT (owner_license_id, grantee_license_id) DO UPDATE SET revoked_at = NULL, created_at = NOW()
   RETURNING grantee_license_id, created_at`, [id, granteeId]);
const list = (id) => pool.query(
  `SELECT g.grantee_license_id, g.created_at, l.email AS grantee_email, l.plan AS grantee_plan
     FROM library_grants g JOIN licenses l ON l.id = g.grantee_license_id
    WHERE g.owner_license_id = $1 AND g.revoked_at IS NULL ORDER BY g.created_at ASC`, [id]);
const revoke = (id, granteeId) => pool.query(
  `UPDATE library_grants SET revoked_at = NOW()
    WHERE owner_license_id = $1 AND grantee_license_id = $2 AND revoked_at IS NULL`, [id, granteeId]);

(async () => {
  await pool.query(`INSERT INTO licenses (id,email,plan) VALUES (1,'owner@x','station_lifetime'),(2,'grantee@x','station'),(3,'other@x','pro')`);

  const checks = [];
  const pass = (label, cond, detail) => checks.push({ label, ok: !!cond, detail });

  // CREATE → LIST
  await create(OWNER, GRANTEE);
  let g = (await list(OWNER)).rows;
  pass('create → list shows grantee with joined email', g.length === 1 && g[0].grantee_license_id === GRANTEE && g[0].grantee_email === 'grantee@x', JSON.stringify(g));

  // Idempotent create (no duplicate)
  await create(OWNER, GRANTEE);
  pass('re-create is idempotent (UNIQUE upsert, still 1 row)', (await list(OWNER)).rows.length === 1);

  // REVOKE → LIST empty
  const rv = await revoke(OWNER, GRANTEE);
  pass('revoke affects exactly 1 row', rv.rowCount === 1);
  pass('list after revoke is empty', (await list(OWNER)).rows.length === 0);

  // Re-revoke is a no-op (already revoked)
  pass('re-revoke affects 0 rows (already revoked)', (await revoke(OWNER, GRANTEE)).rowCount === 0);

  // RE-GRANT un-revokes (ON CONFLICT DO UPDATE SET revoked_at = NULL)
  await create(OWNER, GRANTEE);
  g = (await list(OWNER)).rows;
  pass('re-grant un-revokes (visible again, still 1 row)', g.length === 1 && g[0].grantee_license_id === GRANTEE);

  // Isolation: a different owner has no grants
  pass('unrelated owner (id=3) sees no grants', (await list(3)).rows.length === 0);

  console.log('=== LIBRARY-GRANTS CRUD SMOKE ===');
  let allOk = true;
  for (const c of checks) { console.log(`   ${c.ok ? 'PASS' : 'FAIL'}  ${c.label}`); if (!c.ok) { allOk = false; console.log(`         detail: ${c.detail}`); } }
  console.log('\n=== RESULT:', allOk ? 'CRUD SQL OK ✅' : 'FAIL ❌', '===');
  process.exit(allOk ? 0 : 1);
})().catch(e => { console.error('SMOKE ERROR:', e); process.exit(2); });
