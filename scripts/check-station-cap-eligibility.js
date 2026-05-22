/**
 * Pre-deploy safety check for EB2 (server-side station-count cap).
 * Read-only: SELECT only. No writes.
 *
 * Usage:
 *   railway run node scripts/check-station-cap-eligibility.js
 *
 * The EB2 commit adds a server-side cap on /account/add-station with
 * the following per-plan limits:
 *
 *   free, pro, pro_lifetime, station, station_lifetime → 5 stations
 *   (Note: free is also 1 per onboarding spec; check uses 5 here because
 *   the gate runs AFTER /account/create, and free licenses are still
 *   structurally limited to 1 via the onboarded_at gate in /account/create.
 *   Over-cap detection only matters for tiers reachable via /account/add-station.)
 *   operator → unlimited
 *
 * This script identifies any ACTIVE license currently over the proposed
 * cap — those customers would be unable to add MORE stations after EB2
 * lands (but their existing stations continue to work; the gate applies
 * to new INSERTs only).
 *
 * Exit codes:
 *   0  no over-cap licenses — safe to deploy EB2
 *   1  one or more over-cap licenses found — STOP, decide what to do:
 *        - raise the cap to accommodate them
 *        - grandfather them in (the cap is INSERT-only, so existing
 *          stations stay functional — they just can't add more)
 *        - contact them, case-by-case
 *
 * Paste output verbatim — do not summarize. The operator decides next steps
 * from the full list.
 */
const { Pool } = require('pg');

const PLAN_STATION_LIMITS = {
  free:              1,
  pro:               5,
  pro_lifetime:      5,
  station:           5,
  station_lifetime:  5,
  operator:          -1, // unlimited
};

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Use `railway run node scripts/check-station-cap-eligibility.js`.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  // Pull every active license with its station count. JS-side filter against
  // PLAN_STATION_LIMITS so the cap definition lives in exactly one place in
  // this script — no CASE expression to keep in sync.
  const { rows } = await pool.query(`
    SELECT
      l.id,
      l.email,
      l.plan,
      COUNT(s.*)::int AS station_count
    FROM licenses l
    LEFT JOIN stations s ON s.license_key_id = l.id
    WHERE l.active = true
    GROUP BY l.id, l.email, l.plan
    ORDER BY station_count DESC, l.id
  `);

  const overCap = [];
  const byPlan  = {};
  for (const r of rows) {
    const cap = PLAN_STATION_LIMITS[r.plan];
    if (cap === undefined) {
      // Unknown plan value — flag separately (EB4 prevents new ones, but
      // legacy rows could exist).
      overCap.push({ ...r, cap: '(unknown plan)', reason: 'unknown_plan' });
      continue;
    }
    if (cap === -1) continue; // operator — unlimited
    byPlan[r.plan] = (byPlan[r.plan] || 0) + 1;
    if (r.station_count > cap) {
      overCap.push({ ...r, cap, reason: 'over_cap' });
    }
  }

  console.log(`=== station-cap eligibility check ===`);
  console.log(`total active licenses scanned: ${rows.length}`);
  console.log(`per-plan active counts:`);
  for (const [plan, n] of Object.entries(byPlan)) {
    console.log(`  ${plan.padEnd(20)} ${n}`);
  }
  console.log('');

  if (overCap.length === 0) {
    console.log('=== SAFE TO DEPLOY ===');
    console.log('No active licenses currently exceed the proposed station cap.');
    console.log('EB2 can land without affecting any existing customer.');
    await pool.end();
    process.exit(0);
  }

  console.log(`=== ${overCap.length} OVER-CAP LICENSE(S) — STOP ===`);
  console.log('These licenses currently have more stations than the proposed cap.');
  console.log('Existing stations stay functional after EB2 deploys (the gate is');
  console.log('INSERT-only), but they cannot add MORE stations until the cap is');
  console.log('raised or they are grandfathered in via plan upgrade.');
  console.log('');
  for (const r of overCap) {
    console.log(`id=${r.id}`);
    console.log(`  email          ${r.email}`);
    console.log(`  plan           ${r.plan}`);
    console.log(`  station_count  ${r.station_count}`);
    console.log(`  proposed_cap   ${r.cap}`);
    console.log(`  reason         ${r.reason}`);
    console.log('');
  }

  await pool.end();
  process.exit(1);
}

main().catch(e => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
