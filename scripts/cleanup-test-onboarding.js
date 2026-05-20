/**
 * Reverts the database side-effects of an /account/create test against the
 * test license, so the same license can be re-onboarded from scratch.
 *
 * Hard-coded to license id=4. The whole safety story of this script is that
 * it has no CLI flag for picking a license — anyone wanting to point it at
 * a different row would have to edit the source. Do NOT change LICENSE_ID
 * without re-verifying that id=4 is still the test license in this
 * environment.
 *
 * What /account/create writes (see docs/onboarding-spec-v1.md):
 *   - licenses:           onboarded_at = NOW(), account_name = <input>
 *   - stations:           1 new row with license_key_id = <license.id>
 *   - license_activations: 1 upserted row keyed by (license_key, machine_id),
 *                          station_uuid bound to the new station
 * /account/bind-seat and /account/add-station can add additional rows in
 * stations and license_activations for the same license; this script cleans
 * all of them.
 *
 * Modes (exactly one required):
 *   --dry-run  Pre-flight SELECTs only. Print counts and the DDL/DML that
 *              would run, then exit. No writes.
 *   --execute  Run the deletes + update inside a single transaction.
 *              Refuses (exit 3) if the licenses row at LICENSE_ID does not
 *              exist or fails the sanity check.
 *
 * Sanity check on the license row before doing anything:
 *   - licenses.id = LICENSE_ID must return exactly one row.
 *   - licenses.plan must NOT be 'production' (defense-in-depth — the test
 *     license is plan='pro' in this environment; a production-plan row at
 *     id=4 would mean someone renumbered or this is the wrong DB).
 *
 * Verdict (--execute only): after the post-state re-SELECT, the script
 * prints either "READY FOR RE-TEST" (all five conditions clear) or
 * "CLEANUP INCOMPLETE (failing condition: …)" and exits non-zero. This
 * makes the script self-verifying — no separate inspect-onboarding run
 * needed to confirm the cleanup landed.
 *
 * Exit codes:
 *   2  bad CLI usage
 *   3  refused (license missing, sanity check failed, or query failed)
 *   4  transaction failed (rolled back)
 *   5  cleanup committed but post-state verdict = CLEANUP INCOMPLETE
 *
 * Run from a machine with Railway DATABASE_URL set:
 *   railway run node scripts/cleanup-test-onboarding.js --dry-run
 *   railway run node scripts/cleanup-test-onboarding.js --execute
 *
 * Paste output verbatim — it is the only evidence the cleanup ran.
 */
const { Pool } = require('pg');

const LICENSE_ID = 4;

function ts(v) {
  if (v == null) return '(null)';
  return v.toISOString ? v.toISOString() : String(v);
}

async function loadLicense(pool) {
  const { rows } = await pool.query(
    `SELECT id, email, plan, active, license_key, key_prefix,
            account_name, onboarded_at
       FROM licenses
      WHERE id = $1`,
    [LICENSE_ID]
  );
  return rows[0] || null;
}

async function loadCounts(pool, license) {
  // Activations linked by plaintext key (license_activations.license_key
  // stores the plaintext value that was used in /account/create — see EB1).
  // Falls back to 0 if the license row is bcrypt-only (license_key IS NULL).
  let activationsByKey = 0;
  if (license.license_key) {
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM license_activations WHERE license_key = $1",
      [license.license_key]
    );
    activationsByKey = rows[0].n;
  }

  // Activations linked by station (covers bcrypt-keyed licenses and any
  // activation that lost its license_key linkage but still binds to a
  // station owned by this license).
  const { rows: byStationRows } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM license_activations
      WHERE station_uuid IN (
        SELECT uuid FROM stations WHERE license_key_id = $1
      )`,
    [LICENSE_ID]
  );
  const activationsByStation = byStationRows[0].n;

  const { rows: stationsRows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM stations WHERE license_key_id = $1",
    [LICENSE_ID]
  );
  const stationsCount = stationsRows[0].n;

  return { activationsByKey, activationsByStation, stationsCount };
}

function printLicense(license) {
  console.log(`license row at id=${LICENSE_ID}:`);
  console.log(`  email          ${license.email}`);
  console.log(`  plan           ${license.plan}        active=${license.active}`);
  console.log(`  license_key    ${license.license_key ?? '(null — bcrypt only)'}`);
  console.log(`  key_prefix     ${license.key_prefix ?? '(null)'}`);
  console.log(`  account_name   ${license.account_name ?? '(null)'}`);
  console.log(`  onboarded_at   ${ts(license.onboarded_at)}`);
}

function printCounts(c) {
  console.log(`license_activations (by plaintext key):     ${c.activationsByKey}`);
  console.log(`license_activations (by station_uuid):      ${c.activationsByStation}`);
  console.log(`stations (license_key_id = ${LICENSE_ID}):              ${c.stationsCount}`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const execute = args.includes('--execute');
  if (dryRun === execute) {
    console.error('Usage: node scripts/cleanup-test-onboarding.js (--dry-run | --execute)');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Use `railway run node scripts/cleanup-test-onboarding.js ...`.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  console.log(`mode = ${dryRun ? 'dry-run' : 'execute'}`);
  console.log(`LICENSE_ID = ${LICENSE_ID}`);
  console.log('');

  // ── Sanity check ─────────────────────────────────────────────
  const license = await loadLicense(pool);
  if (!license) {
    console.error(`REFUSING: no licenses row with id=${LICENSE_ID}. Wrong DB, or the test license was deleted.`);
    await pool.end();
    process.exit(3);
  }
  if (license.plan === 'production') {
    console.error(`REFUSING: licenses.id=${LICENSE_ID} has plan='production'. This script is for test data only.`);
    printLicense(license);
    await pool.end();
    process.exit(3);
  }

  console.log('--- Pre-flight license ---');
  printLicense(license);
  console.log('');
  console.log('--- Pre-flight counts (what would be touched) ---');
  const counts = await loadCounts(pool, license);
  printCounts(counts);
  console.log('');

  const planActivationDelete =
    `DELETE FROM license_activations
      WHERE license_key = $1
         OR station_uuid IN (SELECT uuid FROM stations WHERE license_key_id = $2)`;
  const planStationsDelete =
    `DELETE FROM stations WHERE license_key_id = $1`;
  const planLicenseUpdate =
    `UPDATE licenses SET onboarded_at = NULL, account_name = NULL WHERE id = $1`;

  if (dryRun) {
    console.log('--- DRY RUN: planned DML (inside one transaction) ---');
    console.log(`  ${planActivationDelete.replace(/\s+/g, ' ').trim()}`);
    console.log(`    $1 = ${license.license_key ?? '(skipped — license_key is NULL)'}`);
    console.log(`    $2 = ${LICENSE_ID}`);
    console.log(`  ${planStationsDelete}    [$1=${LICENSE_ID}]`);
    console.log(`  ${planLicenseUpdate}    [$1=${LICENSE_ID}]`);
    console.log('');
    console.log('No changes made (dry-run).');
    await pool.end();
    return;
  }

  // ── --execute path ───────────────────────────────────────────
  console.log('--- Executing inside transaction ---');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // If license_key is NULL on the licenses row (bcrypt-only), pass a
    // sentinel that cannot match any real activation key. The station_uuid
    // branch of the WHERE clause still does the work in that case.
    const keyParam = license.license_key ?? '\x00impossible-key\x00';
    const aRes = await client.query(planActivationDelete, [keyParam, LICENSE_ID]);
    console.log(`  DELETE license_activations   rowCount=${aRes.rowCount}`);

    const sRes = await client.query(planStationsDelete, [LICENSE_ID]);
    console.log(`  DELETE stations              rowCount=${sRes.rowCount}`);

    const lRes = await client.query(planLicenseUpdate, [LICENSE_ID]);
    console.log(`  UPDATE licenses              rowCount=${lRes.rowCount}`);

    await client.query('COMMIT');
    console.log('');
    console.log('CLEANUP COMPLETE');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FAILED — rolled back:', e.message);
    process.exit(4);
  } finally {
    client.release();
  }

  // ── Post-state verification ──────────────────────────────────
  console.log('');
  console.log('--- Post-state ---');
  const after = await loadLicense(pool);
  printLicense(after);
  console.log('');
  const afterCounts = await loadCounts(pool, after);
  printCounts(afterCounts);

  // ── Verdict ──────────────────────────────────────────────────
  const failures = [];
  if (after.account_name !== null) {
    failures.push(`account_name is ${JSON.stringify(after.account_name)}, expected NULL`);
  }
  if (after.onboarded_at !== null) {
    failures.push(`onboarded_at is ${ts(after.onboarded_at)}, expected NULL`);
  }
  if (afterCounts.stationsCount !== 0) {
    failures.push(`stations rows = ${afterCounts.stationsCount}, expected 0`);
  }
  if (afterCounts.activationsByKey !== 0) {
    failures.push(`activations matched by license_key = ${afterCounts.activationsByKey}, expected 0`);
  }
  if (afterCounts.activationsByStation !== 0) {
    failures.push(`activations matched by station_uuid = ${afterCounts.activationsByStation}, expected 0`);
  }

  console.log('');
  if (failures.length === 0) {
    console.log('READY FOR RE-TEST');
    console.log(`  (license at id=${LICENSE_ID} has account_name=NULL, onboarded_at=NULL,`);
    console.log('   0 stations, 0 active activations)');
    await pool.end();
  } else {
    console.log('CLEANUP INCOMPLETE');
    console.log(`  (failing condition: ${failures.join('; ')})`);
    await pool.end();
    process.exit(5);
  }
}

main().catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
