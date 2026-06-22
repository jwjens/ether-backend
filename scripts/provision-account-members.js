/**
 * Explicit, per-account RBAC member provisioning (deliberate seeding).
 *
 * This is NOT a blanket rule and NOT part of initDB — it seeds SPECIFIC accounts with a
 * SPECIFIED roster, so existing/live accounts (DJ, OV) get the right Owner + authorized
 * emails on purpose and are never left headless, while stray/dev users rows are never swept
 * in. The platform console's "add email -> position -> stations" will call this same logic
 * per-customer later.
 *
 * Requires the Phase A tables (positions / memberships / membership_station_access) to exist.
 * Idempotent: upserts memberships by (user_id, account_id) — re-running updates, never dupes.
 *
 * Usage:
 *   DRY_RUN=1 node scripts/provision-account-members.js   # wrap in a rollback; persist nothing
 *   node scripts/provision-account-members.js             # apply for real
 *
 * Roster entry: { account, email, position, stations } where stations = 'all' | [uuid, ...].
 * Each scoped station is validated to belong to its account (no cross-account grants).
 */
const { Pool } = require('pg');

// ── DJ + OV roster (per Jeff, 2026-06-21) ──────────────────────────────────────
const ROSTER = [
  { account: 2,  email: 'djdeniro@gmail.com',           position: 'owner', stations: 'all' }, // DJ account owner
  { account: 19, email: 'jensj@opportunityvillage.org', position: 'owner', stations: 'all' }, // OV account owner
  { account: 19, email: 'djdeniro@gmail.com',           position: 'pd',    stations: ['21606342-18d4-470e-9998-047c2e034608'] }, // djdeniro: full operator (PD) of the OV STATION only — NOT OV account owner
];

async function provision(c) {
  for (const e of ROSTER) {
    let u = (await c.query(`SELECT id FROM users WHERE lower(email)=lower($1)`, [e.email])).rows[0];
    if (!u) { u = (await c.query(`INSERT INTO users (email, password_hash, email_verified) VALUES ($1,'',false) RETURNING id`, [e.email])).rows[0]; console.log(`  + created invited user ${e.email} (password set via invite)`); }
    const pos = (await c.query(`SELECT id FROM positions WHERE key=$1 AND account_id IS NULL AND deleted_at IS NULL`, [e.position])).rows[0];
    if (!pos) throw new Error(`unknown position '${e.position}'`);
    const all = e.stations === 'all';
    const m = (await c.query(
      `INSERT INTO memberships (user_id, account_id, position_id, all_stations, status)
       VALUES ($1,$2,$3,$4,'active')
       ON CONFLICT (user_id, account_id) WHERE deleted_at IS NULL
       DO UPDATE SET position_id=EXCLUDED.position_id, all_stations=EXCLUDED.all_stations, status='active', updated_at=NOW()
       RETURNING id`, [u.id, e.account, pos.id, all])).rows[0];
    if (!all) for (const su of e.stations) {
      const ok = (await c.query(`SELECT 1 FROM stations WHERE uuid=$1 AND license_key_id=$2`, [su, e.account])).rows.length;
      if (!ok) throw new Error(`station ${su} is not in account ${e.account} — cross-account grant REJECTED`);
      await c.query(`INSERT INTO membership_station_access (membership_id, station_uuid) VALUES ($1,$2) ON CONFLICT (membership_id, station_uuid) DO NOTHING`, [m.id, su]);
    }
    console.log(`  ${e.email.padEnd(32)} -> account#${e.account} as ${e.position} (${all ? 'all stations' : e.stations.length + ' station(s)'})`);
  }
}

(async () => {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  const dry = process.env.DRY_RUN === '1';
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    console.log(dry ? '== DRY RUN ==' : '== APPLYING ==');
    await provision(c);
    const rows = (await c.query(`SELECT u.email, m.account_id, p.key AS position, m.all_stations FROM memberships m JOIN users u ON u.id=m.user_id JOIN positions p ON p.id=m.position_id WHERE m.deleted_at IS NULL ORDER BY m.account_id, u.email`)).rows;
    console.log('\n=== memberships ==='); for (const r of rows) console.log(`  ${r.email.padEnd(32)} account#${r.account_id} ${r.position} all_stations=${r.all_stations}`);
    if (dry) { await c.query('ROLLBACK'); console.log('\nDRY_RUN — rolled back, nothing persisted.'); }
    else { await c.query('COMMIT'); console.log('\nCOMMITTED.'); }
  } catch (e) { await c.query('ROLLBACK'); console.error('FAILED (rolled back):', e.message); process.exitCode = 1; }
  finally { c.release(); await pool.end(); }
})();
