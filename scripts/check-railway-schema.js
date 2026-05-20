/**
 * One-off Railway schema inspection.
 * Read-only: queries pg_tables and information_schema only.
 *
 * Usage:
 *   1. From a machine with Railway env access:
 *        DATABASE_URL=postgres://... node scripts/check-railway-schema.js
 *   2. Or from Railway CLI:
 *        railway run node scripts/check-railway-schema.js
 *
 * Output goes to stdout. Paste it back verbatim — do not summarize.
 */
const { Pool } = require('pg');

const TABLES_OF_INTEREST = ['licenses', 'license_activations', 'accounts', 'stations', 'seats'];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Set it or use `railway run`.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  console.log('=== ALL PUBLIC TABLES ===');
  const { rows: tables } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
  );
  for (const r of tables) console.log(r.tablename);

  const present = new Set(tables.map(r => r.tablename));

  for (const t of TABLES_OF_INTEREST) {
    console.log(`\n=== ${t.toUpperCase()} ===`);
    if (!present.has(t)) {
      console.log(`(table does not exist)`);
      continue;
    }
    const { rows: cols } = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = $1 AND table_schema = 'public'
       ORDER BY ordinal_position`,
      [t]
    );
    for (const c of cols) {
      console.log(
        `${c.column_name.padEnd(24)} ${String(c.data_type).padEnd(28)} ` +
        `null=${c.is_nullable.padEnd(3)} default=${c.column_default ?? ''}`
      );
    }

    const { rows: idx } = await pool.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname='public' AND tablename = $1
       ORDER BY indexname`,
      [t]
    );
    if (idx.length) {
      console.log(`-- indexes --`);
      for (const i of idx) console.log(`${i.indexname}: ${i.indexdef}`);
    }
  }

  console.log('\n=== ORPHAN ROW COUNTS ===');
  const orphanChecks = [
    { label: 'accounts (total rows)',                   sql: "SELECT COUNT(*)::int AS n FROM accounts" },
    { label: 'licenses WHERE account_id IS NOT NULL',   sql: "SELECT COUNT(*)::int AS n FROM licenses WHERE account_id IS NOT NULL" },
  ];
  for (const { label, sql } of orphanChecks) {
    try {
      const { rows } = await pool.query(sql);
      console.log(`${label.padEnd(40)} ${rows[0].n}`);
    } catch (e) {
      console.log(`${label.padEnd(40)} ERROR: ${e.message}`);
    }
  }

  await pool.end();
}

main().catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
