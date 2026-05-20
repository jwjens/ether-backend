/**
 * One-off Railway onboarding-data inspection.
 * Read-only: SELECT only. No writes.
 *
 * Usage:
 *   railway run node scripts/inspect-onboarding.js
 *
 * Prints every row in:
 *   - stations
 *   - license_activations
 *
 * Use after running an onboarding endpoint test to verify the data the
 * endpoint wrote. Paste output verbatim — do not summarize.
 *
 * license_activations.license_key is truncated to first 12 chars so
 * full plaintext keys are not echoed into transcripts. Use list-licenses.js
 * if you need the full key for a row.
 */
const { Pool } = require('pg');

function ts(v) {
  if (v == null) return '(null)';
  return v.toISOString ? v.toISOString() : String(v);
}

function maskKey(k) {
  if (k == null) return '(null)';
  return k.length > 12 ? `${k.slice(0, 12)}…` : k;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Use `railway run node scripts/inspect-onboarding.js`.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  // ── stations ──────────────────────────────────────────────────
  const { rows: stations } = await pool.query(`
    SELECT
      id,
      uuid,
      license_key_id,
      name,
      nickname,
      frequency,
      call_letters,
      created_at,
      updated_at
    FROM stations
    ORDER BY created_at ASC, id ASC
  `);

  console.log(`=== stations (${stations.length} rows) ===\n`);
  if (stations.length === 0) {
    console.log('(no rows)\n');
  } else {
    for (const r of stations) {
      console.log(`id=${r.id}`);
      console.log(`  uuid           ${r.uuid}`);
      console.log(`  license_key_id ${r.license_key_id}`);
      console.log(`  name           ${r.name}`);
      console.log(`  nickname       ${r.nickname ?? '(null)'}`);
      console.log(`  frequency      ${r.frequency ?? '(null)'}`);
      console.log(`  call_letters   ${r.call_letters ?? '(null)'}`);
      console.log(`  created_at     ${ts(r.created_at)}`);
      console.log(`  updated_at     ${ts(r.updated_at)}`);
      console.log('');
    }
  }

  // ── license_activations ───────────────────────────────────────
  const { rows: activations } = await pool.query(`
    SELECT
      id,
      license_key,
      machine_id,
      machine_name,
      os,
      ip_address,
      station_uuid,
      activated_at,
      last_seen,
      deauthorized_at
    FROM license_activations
    ORDER BY activated_at ASC, id ASC
  `);

  console.log(`=== license_activations (${activations.length} rows) ===\n`);
  if (activations.length === 0) {
    console.log('(no rows)\n');
  } else {
    for (const r of activations) {
      console.log(`id=${r.id}`);
      console.log(`  license_key     ${maskKey(r.license_key)}`);
      console.log(`  machine_id      ${r.machine_id}`);
      console.log(`  machine_name    ${r.machine_name ?? '(null)'}`);
      console.log(`  os              ${r.os ?? '(null)'}`);
      console.log(`  ip_address      ${r.ip_address ?? '(null)'}`);
      console.log(`  station_uuid    ${r.station_uuid ?? '(null — not bound to a station)'}`);
      console.log(`  activated_at    ${ts(r.activated_at)}`);
      console.log(`  last_seen       ${ts(r.last_seen)}`);
      console.log(`  deauthorized_at ${r.deauthorized_at ? ts(r.deauthorized_at) : '(null — active)'}`);
      console.log('');
    }
  }

  // ── summary ───────────────────────────────────────────────────
  const activeSeats = activations.filter(r => r.deauthorized_at == null).length;
  const boundSeats  = activations.filter(r => r.station_uuid != null && r.deauthorized_at == null).length;
  console.log(`=== summary ===`);
  console.log(`stations                  ${stations.length}`);
  console.log(`activations (total)       ${activations.length}`);
  console.log(`activations (active)      ${activeSeats}  (deauthorized_at IS NULL)`);
  console.log(`activations (bound)       ${boundSeats}  (active AND station_uuid IS NOT NULL)`);

  await pool.end();
}

main().catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
