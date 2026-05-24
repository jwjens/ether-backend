/**
 * One-off cloud cleanup for EB17: delete the orphan "Ether Radio" station from
 * Railway's stations table, together with its dangling seat binding(s).
 *
 * Context: onboarding "Add a new station" creates the cloud row on submit (the
 * /account/add-station POST) before the customer commits to finishing the flow.
 * An earlier onboarding session was abandoned mid-flow after bind-seat had
 * already fired, so under license_key_id=2 there is now both an orphan
 * stations row ("Ether Radio") AND a license_activations row whose station_uuid
 * points at it — neither removable via UI. See close-out-tracker.md EB17 (the
 * abandonment-orphan class) and OB18 (the success-path mirror fix).
 *
 * Orphan station implies orphan binding by definition (both came from the same
 * dead flow), so this deletes BOTH in one transaction.
 *
 * Ordering is load-bearing: license_activations.station_uuid is
 *   REFERENCES stations(uuid) ON DELETE SET NULL
 * so the station must be deleted AFTER the binding rows — deleting the station
 * first would NULL their station_uuid and we'd lose the handle to them. The
 * binding rows are hard-deleted (not soft-deleted like /account/deauthorize-seat
 * does) — appropriate for an interrupted-flow orphan, and it frees the seat the
 * dangling active binding was consuming. Nothing references license_activations,
 * so the hard delete violates no FK.
 *
 * Same shape as backfill-railway-stations.js: Pool + SSL, read-then-delete,
 * transactional (BEGIN/COMMIT, ROLLBACK on mismatch), full BEFORE/AFTER state.
 *
 * Idempotent: a re-run after the station is gone finds 0 matching stations and
 * exits 0 as a clean no-op. >1 matching stations is a hard abort (ambiguous).
 * In the transaction, any expected-vs-actual delete-count mismatch rolls back.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/delete-orphan-station.js
 *   # or from Railway:  railway run node scripts/delete-orphan-station.js
 */
const { Pool } = require('pg');

const LICENSE_KEY_ID = 2;              // djdeniro@gmail.com, ETHER-OWNER-2026
const TARGET_NAME    = 'Ether Radio';

// column_name values used in the binding lookup come from information_schema
// (trusted DB metadata, not user input); still constrained to a plain identifier
// before any interpolation as defense-in-depth.
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Build a "(\"col\" = $1 OR \"col2\" = $2 ...)" predicate matching any
// license_activations row that references this station. *_uuid columns compare
// to the station uuid; any other %station% column compares to the id.
function refPredicate(refCols, target) {
  const parts = [];
  const params = [];
  for (const { column_name } of refCols) {
    if (!SAFE_IDENT.test(column_name)) {
      throw new Error(`unexpected column identifier from information_schema: "${column_name}"`);
    }
    params.push(/uuid/i.test(column_name) ? target.uuid : target.id);
    parts.push(`"${column_name}" = $${params.length}`);
  }
  return { sql: parts.join(' OR '), params, cols: refCols.map(c => c.column_name) };
}

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
    // ── BEFORE: full station context for this license ────────────
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

    // ── Locate the targeted station ──────────────────────────────
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
    console.log('=== EXACTLY ONE station match — target ===');
    console.log(`  id          = ${target.id}`);
    console.log(`  uuid        = ${target.uuid}`);
    console.log(`  name        = "${target.name}"`);
    console.log(`  created_at  = ${target.created_at?.toISOString?.() ?? target.created_at}\n`);

    // ── Discover seat binding(s) referencing this station ────────
    const { rows: refCols } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'license_activations'
          AND column_name ILIKE '%station%'
        ORDER BY column_name`
    );

    let pred = null;
    let bindingCount = 0;
    if (refCols.length === 0) {
      console.log('license_activations has no station-referencing column — no bindings to delete.');
    } else {
      pred = refPredicate(refCols, target);
      const { rows: bc } = await client.query(
        `SELECT COUNT(*)::int AS c FROM license_activations WHERE ${pred.sql}`,
        pred.params
      );
      bindingCount = bc[0].c;
      console.log(`Seat bindings referencing this station (via ${pred.cols.join(', ')}): ${bindingCount}`);
    }

    // ── BEFORE: counts to delete ─────────────────────────────────
    console.log(`\nTO DELETE → stations: 1 (id=${target.id})   license_activations bindings: ${bindingCount}\n`);

    // ── Transaction: bindings FIRST, then the station ────────────
    await client.query('BEGIN');

    if (pred && bindingCount > 0) {
      const delBind = await client.query(`DELETE FROM license_activations WHERE ${pred.sql}`, pred.params);
      if (delBind.rowCount !== bindingCount) {
        console.error(`ABORT: expected to delete ${bindingCount} binding row(s), deleted ${delBind.rowCount}. Rolling back.`);
        await client.query('ROLLBACK');
        process.exit(1);
      }
      console.log(`DELETE license_activations: removed ${delBind.rowCount} binding row(s).`);
    }

    const delSta = await client.query(`DELETE FROM stations WHERE id = $1`, [target.id]);
    if (delSta.rowCount !== 1) {
      console.error(`ABORT: expected to delete exactly 1 station row, deleted ${delSta.rowCount}. Rolling back.`);
      await client.query('ROLLBACK');
      process.exit(1);
    }
    console.log(`DELETE stations: removed station id=${target.id} (uuid=${target.uuid}).`);

    await client.query('COMMIT');
    console.log('Committed.\n');

    // ── AFTER: verify both are gone ──────────────────────────────
    const { rows: after } = await client.query(
      `SELECT id, uuid, name, call_letters, created_at FROM stations WHERE license_key_id = $1 ORDER BY created_at ASC`,
      [LICENSE_KEY_ID]
    );
    console.log(`=== AFTER: license_key_id=${LICENSE_KEY_ID} has ${after.length} station(s) ===`);
    for (const r of after) {
      console.log(`  id=${r.id}  uuid=${r.uuid}  name=${r.name}  call_letters=${r.call_letters ?? '(null)'}`);
    }

    let bindingsAfter = 0;
    if (pred) {
      const { rows: ba } = await client.query(
        `SELECT COUNT(*)::int AS c FROM license_activations WHERE ${pred.sql}`,
        pred.params
      );
      bindingsAfter = ba[0].c;
    }
    console.log(`license_activations bindings referencing target uuid AFTER: ${bindingsAfter}`);

    const stationStillThere = after.some(r => r.uuid === target.uuid);
    if (stationStillThere || after.length !== before.length - 1 || bindingsAfter !== 0) {
      console.error(`\nVERIFICATION FAILED: stations expected ${before.length - 1} (got ${after.length}` +
                    (stationStillThere ? ', target uuid still present' : '') +
                    `), bindings expected 0 (got ${bindingsAfter}).`);
      process.exit(1);
    }
    console.log(`\n✓ orphan "${TARGET_NAME}" (uuid=${target.uuid}) and its ${bindingCount} seat binding(s) removed cleanly.`);
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
