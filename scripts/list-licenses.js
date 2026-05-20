/**
 * One-off Railway license inventory.
 * Read-only: SELECT only. No writes.
 *
 * Usage:
 *   railway run node scripts/list-licenses.js
 *
 * Lists every row in licenses with the fields needed to pick a test key
 * for the onboarding flow. Paste output verbatim — do not summarize.
 *
 * Columns:
 *   id            licenses.id
 *   email         contact email
 *   plan          free / pro / station
 *   active        true/false
 *   key_format    'plaintext' (legacy license_key set), 'bcrypt' (key_hash set, license_key NULL), or 'mixed'
 *   key_or_prefix license_key for plaintext rows; key_prefix for bcrypt rows (first 12 chars, safe to display)
 *   onboarded_at  NULL if /account/create has never run; timestamp if it has
 *   account_name  display label (NULL if no account_name yet)
 *   created_at
 *   last_validated
 *
 * Pick a license where onboarded_at IS NULL for the happy-path /account/create
 * test. After the test, that license will have onboarded_at set, account_name
 * set, a stations row, and a license_activations row for the test machine_id.
 */
const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Use `railway run node scripts/list-licenses.js`.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const { rows } = await pool.query(`
    SELECT
      id,
      email,
      plan,
      active,
      CASE
        WHEN key_hash IS NOT NULL AND license_key IS NULL THEN 'bcrypt'
        WHEN key_hash IS NULL     AND license_key IS NOT NULL THEN 'plaintext'
        WHEN key_hash IS NOT NULL AND license_key IS NOT NULL THEN 'mixed'
        ELSE 'none'
      END AS key_format,
      COALESCE(license_key, key_prefix) AS key_or_prefix,
      onboarded_at,
      account_name,
      created_at,
      last_validated
    FROM licenses
    ORDER BY created_at DESC
  `);

  console.log(`=== licenses (${rows.length} rows) ===\n`);
  if (rows.length === 0) {
    console.log('(no rows)');
  } else {
    for (const r of rows) {
      console.log(`id=${r.id}`);
      console.log(`  email          ${r.email}`);
      console.log(`  plan           ${r.plan}        active=${r.active}`);
      console.log(`  key_format     ${r.key_format}`);
      console.log(`  key_or_prefix  ${r.key_or_prefix ?? '(null)'}`);
      console.log(`  account_name   ${r.account_name ?? '(null)'}`);
      console.log(`  onboarded_at   ${r.onboarded_at ? r.onboarded_at.toISOString() : '(null — eligible for /account/create)'}`);
      console.log(`  created_at     ${r.created_at?.toISOString?.() ?? r.created_at}`);
      console.log(`  last_validated ${r.last_validated ? r.last_validated.toISOString() : '(null)'}`);
      console.log('');
    }
  }

  // Quick aggregate so the picker can see what's available at a glance.
  const onboardable = rows.filter(r => r.active && r.onboarded_at == null);
  console.log(`=== summary ===`);
  console.log(`total            ${rows.length}`);
  console.log(`active           ${rows.filter(r => r.active).length}`);
  console.log(`onboardable      ${onboardable.length}  (active=true AND onboarded_at IS NULL)`);

  await pool.end();
}

main().catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
