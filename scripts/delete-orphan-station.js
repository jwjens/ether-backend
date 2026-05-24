/**
 * One-off cloud cleanup for EB17: delete the orphan "Ether Radio" station from
 * Railway's stations table.
 *
 * Context: onboarding "Add a new station" creates the cloud row on submit (the
 * /account/add-station POST) before the customer commits to finishing the flow.
 * An earlier onboarding session was abandoned mid-flow, so "Ether Radio" was
 * INSERTed server-side under license_key_id=2 but never got a corresponding
 * local row — and there's no UI to delete it. See close-out-tracker.md EB17
 * (the abandonment-orphan class) and OB18 (the success-path mirror fix).
 *
 * Same shape as backfill-railway-stations.js: Pool + SSL, read-then-delete,
 * transactional (BEGIN/COMMIT, ROLLBACK on error), full BEFORE/AFTER state
 * printed, and the exact target uuid echoed before deletion.
 *
 * Idempotent: a re-run after the row is gone finds 0 matches and exits 0 as a
 * clean no-op. Only >1 matches is a hard abort (ambiguous — refuse to guess).
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/delete-orphan-station.js
 *   # or from Railway:  railway run node scripts/delete-orphan-station.js
 */
const { Pool } = require('pg');

const LICENSE_KEY_ID = 2;              // djdeniro@gmail.com, ETHER-OWNER-2026
const TARGET_NAME    = 'Ether Radio';

// column_name values used in the activations check come from information_schema
// (trusted DB metadata, not user input); still constrained to a plain identifier
// before any interpolation as defense-in-depth.
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Set it (or use `railway run node scripts/delete-orphan-station.js`).');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();

  try {
    // ── BEFORE: full context for this license ────────────────────
    const { rows: before } = await client.query(
      `SELECT id, uuid, name, call_letters, created_at FROM stations WHERE license_key_id = $1 ORDER BY created_at ASC`,
      [LICENSE_KEY_ID]
    );
    console.log(`=== BEFORE: license_key_id=${LICENSE_KEY_ID} has ${before.length} station(s) ===`);
    for (const r of before) {
      console.log(`  id=${r.id}  uuid=${r.uuid}  name=${r.name}  call_letters=${r.call_letters ?? '(null)'}`);
    }
    console.log('');

    // ── Sanity: license exists (abort if not — no orphan deletes) ─
    const { rows: licCheck } = await client.query(
      `SELECT id, email, plan FROM licenses WHERE id = $1`,
      [LICENSE_KEY_ID]
    );
    if (licCheck.length === 0) {
      console.error(`ABORT: licenses.id=${LICENSE_KEY_ID} does not exist. No delete.`);
      process.exit(1);
    }
    console.log(`License OK: id=${licCheck[0].id}  email=${licCheck[0].email}  plan=${licCheck[0].plan}\n`);

    // ── Locate the targeted match ────────────────────────────────
    const { rows: match } = await client.query(
      `SELECT id, uuid, name, license_key_id, created_at
         FROM stations
        WHERE license_key_id = $1 AND name = $2
        ORDER BY id`,
      [LICENSE_KEY_ID, TARGET_NAME]
    );

    // 0 = idempotent no-op (clean exit); >1 = ambiguous hard abort.
    if (match.length === 0) {
      console.log(`0 rows match license_key_id=${LICENSE_KEY_ID} AND name="${TARGET_NAME}" — already deleted or never existed. Nothing to do.`);
      process.exit(0);
    }
    if (match.length > 1) {
      console.error(`ABORT: ${match.length} rows match license_key_id=${LICENSE_KEY_ID} AND name="${TARGET_NAME}". Refusing to delete an ambiguous set — investigate which is the orphan.`);
      for (const r of match) console.error(`  id=${r.id}  uuid=${r.uuid}`);
      process.exit(1);
    }

    const target = match[0];
    console.log('=== EXACTLY ONE match — target to delete ===');
    console.log(`  id          = ${target.id}`);
    console.log(`  uuid        = ${target.uuid}`);
    console.log(`  name        = "${target.name}"`);
    console.log(`  created_at  = ${target.created_at?.toISOString?.() ?? target.created_at}\n`);

    // ── Sanity: any license_activations rows referencing this station? ──
    // The seat→station link column name isn't assumed — discover any
    // license_activations column matching %station% and check it (*_uuid cols
    // compare to the uuid, others to the id). If a referencing row exists we
    // ABORT and flag for review rather than silently removing a seat binding.
    // (A station referenced by an FK elsewhere would also make the DELETE below
    // fail and roll back — a safe outcome that surfaces the coupling.)
    const { rows: refCols } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'license_activations'
          AND column_name ILIKE '%station%'
        ORDER BY column_name`
    );
    if (refCols.length === 0) {
      console.log('license_activations has no station-referencing column — nothing to check.\n');
    } else {
      const blocking = [];
      for (const { column_name } of refCols) {
        if (!SAFE_IDENT.test(column_name)) {
          throw new Error(`unexpected column identifier from information_schema: "${column_name}"`);
        }
        const value = /uuid/i.test(column_name) ? target.uuid : target.id;
        const { rows } = await client.query(
          `SELECT COUNT(*)::int AS c FROM license_activations WHERE "${column_name}" = $1`,
          [value]
        );
        console.log(`license_activations.${column_name} referencing target: ${rows[0].c} row(s)`);
        if (rows[0].c > 0) blocking.push({ column_name, count: rows[0].c });
      }
      if (blocking.length > 0) {
        console.error('\nABORT: license_activations rows reference this station — flagged for review (NOT deleted):');
        for (const b of blocking) console.error(`  ${b.column_name}: ${b.count} row(s)`);
        console.error('Decide whether those seat bindings should be removed, then handle that and re-run.');
        process.exit(1);
      }
      console.log('');
    }

    // ── DELETE — atomic ──────────────────────────────────────────
    await client.query('BEGIN');
    const del = await client.query(`DELETE FROM stations WHERE id = $1`, [target.id]);
    if (del.rowCount !== 1) {
      console.error(`ABORT: expected to delete exactly 1 row, deleted ${del.rowCount}. Rolling back.`);
      await client.query('ROLLBACK');
      process.exit(1);
    }
    await client.query('COMMIT');
    console.log(`DELETE: removed station id=${target.id} (uuid=${target.uuid}) — 1 row.\n`);

    // ── AFTER: verify the orphan is gone ─────────────────────────
    const { rows: after } = await client.query(
      `SELECT id, uuid, name, call_letters, created_at FROM stations WHERE license_key_id = $1 ORDER BY created_at ASC`,
      [LICENSE_KEY_ID]
    );
    console.log(`=== AFTER: license_key_id=${LICENSE_KEY_ID} has ${after.length} station(s) ===`);
    for (const r of after) {
      console.log(`  id=${r.id}  uuid=${r.uuid}  name=${r.name}  call_letters=${r.call_letters ?? '(null)'}`);
    }

    const stillThere = after.some(r => r.uuid === target.uuid);
    if (stillThere || after.length !== before.length - 1) {
      console.error(`\nVERIFICATION FAILED: expected ${before.length - 1} row(s) after delete, found ${after.length}` +
                    (stillThere ? ' (target uuid still present)' : '') + '.');
      process.exit(1);
    }
    console.log(`\n✓ orphan "${TARGET_NAME}" (uuid=${target.uuid}) removed cleanly.`);
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
