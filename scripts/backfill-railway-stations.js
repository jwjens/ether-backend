/**
 * One-off backfill for EB16: register djdeniro's local stations
 * (Opportunity Village, US Phenomenon) in Railway's stations table.
 *
 * Context: when onboarding was added, pre-existing local installs continued
 * running without ever INSERTing their stations server-side. djdeniro@gmail.com
 * (license_key_id=2) has 2 local stations but 0 server-side rows, so the
 * /account/connect flow on a 2nd machine sees an empty list.
 *
 * Local-side uuids and created_at/updated_at are preserved so peer sync stays
 * consistent (the local rows in openair.db are the source of truth for the
 * uuid namespace; this insert mirrors them server-side).
 *
 * Idempotent — ON CONFLICT (uuid) DO NOTHING. Safe to re-run.
 *
 * Usage:
 *   railway ssh node scripts/backfill-railway-stations.js
 *
 * Read-then-write: prints before-state, runs INSERT inside a transaction,
 * prints after-state. Aborts and rolls back on any mismatch.
 */
const { Pool } = require('pg');

const LICENSE_KEY_ID = 2;  // djdeniro@gmail.com, ETHER-OWNER-2026

// Source: scripts/tmp-list-local-stations.js output against
// C:\Users\jensj\AppData\Roaming\com.ether.radio\openair.db on 2026-05-23
const STATIONS_TO_BACKFILL = [
  {
    uuid:         '92e8c81c-c7bf-4289-9bb3-49a92bcf76af',
    name:         'Opportunity Village',
    nickname:     null,
    frequency:    null,                          // local row is empty string → null in Railway
    call_letters: null,                          // local has no callsign for OV
    created_at:   '2026-04-21T18:26:29.000Z',    // local ISO timestamp, preserved
    updated_at:   '2026-05-14T18:38:25.560Z',
  },
  {
    uuid:         'b569699b-775f-4bee-9d06-c4297378745a',
    name:         'US Phenomenon',
    nickname:     null,
    frequency:    null,                          // local row is empty string → null in Railway
    call_letters: 'USPH',                        // local callsign
    created_at:   new Date(1777398183 * 1000).toISOString(),  // local stored UNIX seconds; converted
    updated_at:   '2026-05-14T18:38:25.557Z',
  },
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Use `railway ssh node scripts/backfill-railway-stations.js`.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();

  try {
    // ── Before-state ─────────────────────────────────────────────
    const { rows: before } = await client.query(
      `SELECT id, uuid, name, call_letters, created_at FROM stations WHERE license_key_id = $1 ORDER BY created_at ASC`,
      [LICENSE_KEY_ID]
    );
    console.log(`=== BEFORE: license_key_id=${LICENSE_KEY_ID} has ${before.length} station(s) ===`);
    for (const r of before) {
      console.log(`  id=${r.id}  uuid=${r.uuid}  name=${r.name}  call_letters=${r.call_letters ?? '(null)'}`);
    }
    console.log('');

    // Confirm license exists (sanity check — abort if not, no orphan rows).
    const { rows: licCheck } = await client.query(
      `SELECT id, email, plan FROM licenses WHERE id = $1`,
      [LICENSE_KEY_ID]
    );
    if (licCheck.length === 0) {
      console.error(`ABORT: licenses.id=${LICENSE_KEY_ID} does not exist. No insert.`);
      process.exit(1);
    }
    console.log(`License OK: id=${licCheck[0].id}  email=${licCheck[0].email}  plan=${licCheck[0].plan}`);
    console.log('');

    // ── Backfill INSERT (idempotent via ON CONFLICT) ─────────────
    await client.query('BEGIN');

    let inserted = 0;
    let skipped  = 0;
    for (const s of STATIONS_TO_BACKFILL) {
      const result = await client.query(
        `INSERT INTO stations (uuid, license_key_id, name, nickname, frequency, call_letters, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (uuid) DO NOTHING
         RETURNING id`,
        [s.uuid, LICENSE_KEY_ID, s.name, s.nickname, s.frequency, s.call_letters, s.created_at, s.updated_at]
      );
      if (result.rowCount > 0) {
        console.log(`INSERT: ${s.name} (uuid=${s.uuid}) → new id=${result.rows[0].id}`);
        inserted++;
      } else {
        console.log(`SKIP (already present): ${s.name} (uuid=${s.uuid})`);
        skipped++;
      }
    }

    // ── After-state ──────────────────────────────────────────────
    const { rows: after } = await client.query(
      `SELECT id, uuid, name, call_letters, created_at FROM stations WHERE license_key_id = $1 ORDER BY created_at ASC`,
      [LICENSE_KEY_ID]
    );
    console.log('');
    console.log(`=== AFTER: license_key_id=${LICENSE_KEY_ID} has ${after.length} station(s) ===`);
    for (const r of after) {
      console.log(`  id=${r.id}  uuid=${r.uuid}  name=${r.name}  call_letters=${r.call_letters ?? '(null)'}`);
    }
    console.log('');

    // Sanity check: after-count must equal before-count + inserted.
    if (after.length !== before.length + inserted) {
      console.error(`ABORT: count mismatch — before=${before.length} + inserted=${inserted} ≠ after=${after.length}. Rolling back.`);
      await client.query('ROLLBACK');
      process.exit(1);
    }

    await client.query('COMMIT');
    console.log(`✓ committed. inserted=${inserted} skipped=${skipped} total=${after.length}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FAILED:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
