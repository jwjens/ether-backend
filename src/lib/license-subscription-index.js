'use strict';
// ONE LICENSE PER STRIPE SUBSCRIPTION (billing test 2026-11-01: one Live 128 purchase made two licenses — the account
// checkout and the invoice webhook arrived together and each inserted one). The database enforces it with a unique
// index on licenses.stripe_subscription_id (licenses without a subscription — trials, platform-made, lifetime — are not
// affected: the index covers only rows where it is set). The webhook inserts with ON CONFLICT DO NOTHING and uses the
// winner's license (src/lib/stripe-webhook.js).
//
// Made at boot (initDB), guarded: if the table already holds two licenses for one subscription the index cannot be
// made; the server still starts, logs those subscriptions, and makes no change to any license (which one to keep is a
// human decision). Production: see docs/one-license-per-subscription-2026-11-01.md (desktop repo).
const INDEX = "licenses_one_per_stripe_subscription";
const CREATE_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX} ON licenses (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL`;
// Every license that has a subscription (a few hundred rows); grouped in JS — plain SQL every Postgres (and the test
// database) runs the same way.
const DUPLICATES_SQL = `SELECT id, email, plan, active, stripe_subscription_id, created_at FROM licenses
  WHERE stripe_subscription_id IS NOT NULL ORDER BY stripe_subscription_id, id`;

/** Subscriptions with more than one license: [{ subscription, licenses: [{id, email, plan, active, created_at}] }]. */
async function duplicateSubscriptions(pool) {
  const rows = (await pool.query(DUPLICATES_SQL)).rows;
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.stripe_subscription_id)) by.set(r.stripe_subscription_id, []);
    by.get(r.stripe_subscription_id).push({ id: r.id, email: r.email, plan: r.plan, active: r.active, created_at: r.created_at });
  }
  return [...by].filter(([, licenses]) => licenses.length > 1).map(([subscription, licenses]) => ({ subscription, licenses }));
}

/** Make the index, or report why not. Never throws; never writes a license. */
async function ensureOneLicensePerSubscription(pool, log = console) {
  const dups = await duplicateSubscriptions(pool).catch((e) => { log.warn(`[licenses] duplicate check failed: ${e.message}`); return null; });
  if (dups && dups.length) {
    log.error(`[licenses] ${INDEX} NOT made: ${dups.length} subscription(s) already have more than one license — ` +
      dups.map((d) => `${d.subscription}: ${d.licenses.map((l) => `${l.id} ${l.email}`).join(", ")}`).join("; ") +
      ". No license was changed. Until it is made, two webhooks arriving together can still make a second license.");
    return { made: false, duplicates: dups };
  }
  try { await pool.query(CREATE_SQL); return { made: true, duplicates: [] }; }
  catch (e) { log.error(`[licenses] ${INDEX} NOT made: ${e.message}`); return { made: false, error: e.message, duplicates: dups || [] }; }
}

module.exports = { ensureOneLicensePerSubscription, duplicateSubscriptions, INDEX, CREATE_SQL, DUPLICATES_SQL };
