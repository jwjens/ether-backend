/**
 * Drops the orphaned `accounts` table and `licenses.account_id` column.
 *
 * Context: both objects were created out-of-band against Railway during
 * abandoned B-02 work (see docs/sync-backend-design-v0.md §10). No committed
 * code references either object — verified by grep across src/ on
 * 2026-05-20. The 1-license-1-account product decision means the accounts
 * table will never be wired up in its current shape.
 *
 * Modes (exactly one required):
 *   --dry-run  Run COUNT queries, print what would be dropped, exit.
 *              No DDL is executed.
 *   --execute  Run the ALTER + DROP inside a single transaction.
 *              Refuses if either count is non-zero. Refuses if a count
 *              query failed (unknown state == don't touch).
 *
 * Refusal exit codes:
 *   2  bad CLI usage
 *   3  refused (non-zero row counts or query failure)
 *   4  transaction failed (rolled back)
 *
 * Run from a machine with Railway DATABASE_URL set:
 *   $env:DATABASE_URL = "postgres://..."   # PowerShell
 *   node scripts/cleanup-orphaned-accounts.js --dry-run
 *   node scripts/cleanup-orphaned-accounts.js --execute
 *
 * Paste output verbatim — it is the only evidence the drop ran.
 */
const { Pool } = require('pg');

const COUNT_ACCOUNTS           = "SELECT COUNT(*)::int AS n FROM accounts";
const COUNT_LICENSE_ACCOUNT_ID = "SELECT COUNT(*)::int AS n FROM licenses WHERE account_id IS NOT NULL";

async function getCounts(pool) {
  const out = {
    accountsCount: null,           accountsError: null,
    licenseAccountIdCount: null,   licenseAccountIdError: null,
  };
  try { out.accountsCount = (await pool.query(COUNT_ACCOUNTS)).rows[0].n; }
  catch (e) { out.accountsError = e.message; }
  try { out.licenseAccountIdCount = (await pool.query(COUNT_LICENSE_ACCOUNT_ID)).rows[0].n; }
  catch (e) { out.licenseAccountIdError = e.message; }
  return out;
}

function printCounts(c) {
  console.log(`accounts (total rows):              ` +
    (c.accountsError ? `ERROR: ${c.accountsError}` : `${c.accountsCount}`));
  console.log(`licenses WHERE account_id NOT NULL: ` +
    (c.licenseAccountIdError ? `ERROR: ${c.licenseAccountIdError}` : `${c.licenseAccountIdCount}`));
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const execute = args.includes('--execute');
  if (dryRun === execute) {
    console.error('Usage: node scripts/cleanup-orphaned-accounts.js (--dry-run | --execute)');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  console.log(`mode = ${dryRun ? 'dry-run' : 'execute'}`);
  console.log('');
  console.log('--- Pre-flight counts ---');
  const counts = await getCounts(pool);
  printCounts(counts);
  console.log('');

  const accountsBlocks =
    counts.accountsError != null || (counts.accountsCount ?? 0) > 0;
  const licenseAccountIdBlocks =
    counts.licenseAccountIdError != null || (counts.licenseAccountIdCount ?? 0) > 0;

  if ((counts.accountsCount ?? 0) > 0) {
    console.log(`REFUSING TO DROP: ${counts.accountsCount} rows exist in accounts`);
  }
  if ((counts.licenseAccountIdCount ?? 0) > 0) {
    console.log(`REFUSING TO DROP: ${counts.licenseAccountIdCount} licenses have a non-NULL account_id`);
  }
  if (counts.accountsError) {
    console.log(`REFUSING TO DROP accounts: count query failed (table may be missing or unreachable)`);
  }
  if (counts.licenseAccountIdError) {
    console.log(`REFUSING TO DROP licenses.account_id: count query failed (column may be missing or unreachable)`);
  }

  if (dryRun) {
    console.log('');
    console.log('--- DRY RUN: planned DDL ---');
    console.log('Would execute inside a single transaction:');
    if (!licenseAccountIdBlocks) {
      console.log('  ALTER TABLE licenses DROP COLUMN IF EXISTS account_id;');
    } else {
      console.log('  (skipped: licenses.account_id — see refusal above)');
    }
    if (!accountsBlocks) {
      console.log('  DROP TABLE IF EXISTS accounts;');
    } else {
      console.log('  (skipped: accounts — see refusal above)');
    }
    console.log('');
    console.log('No changes made (dry-run).');
    await pool.end();
    return;
  }

  // --execute path
  if (accountsBlocks || licenseAccountIdBlocks) {
    console.log('');
    console.log('ABORTING: at least one object is blocked. Investigate, then re-run.');
    await pool.end();
    process.exit(3);
  }

  console.log('--- Executing DDL inside transaction ---');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE licenses DROP COLUMN IF EXISTS account_id');
    console.log('  ALTER TABLE licenses DROP COLUMN account_id   OK');
    await client.query('DROP TABLE IF EXISTS accounts');
    console.log('  DROP TABLE accounts                            OK');
    await client.query('COMMIT');
    console.log('');
    console.log('DROP COMPLETE');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FAILED — rolled back:', e.message);
    process.exit(4);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
