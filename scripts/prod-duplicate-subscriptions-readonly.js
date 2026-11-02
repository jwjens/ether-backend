'use strict';
// READ-ONLY: which Stripe subscriptions already have more than one license (2026-11-01). Lists them with emails;
// changes nothing. The session is read-only twice over (default_transaction_read_only on the connection, and a
// READ ONLY transaction that is rolled back), so not even a mistake in this file could write.
//   railway run --service Postgres node scripts/prod-duplicate-subscriptions-readonly.js
// (uses DATABASE_PUBLIC_URL — the Postgres service's public proxy; the backend's own DATABASE_URL is internal-only)
const { Client } = require("pg");
const { DUPLICATES_SQL, duplicateSubscriptions } = require("../src/lib/license-subscription-index");

(async () => {
  const url = process.env.DATABASE_PUBLIC_URL;
  if (!url) { console.error("DATABASE_PUBLIC_URL is not set (run through `railway run --service Postgres`)."); process.exit(1); }
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, options: "-c default_transaction_read_only=on" });
  await c.connect();
  try {
    await c.query("BEGIN TRANSACTION READ ONLY");
    const ro = (await c.query("SHOW transaction_read_only")).rows[0].transaction_read_only;
    if (ro !== "on") throw new Error(`STOPPED: the session is not read-only (${ro}); nothing was read`);
    const all = (await c.query("SELECT COUNT(*)::int AS n FROM licenses WHERE stripe_subscription_id IS NOT NULL")).rows[0].n;
    const dups = await duplicateSubscriptions({ query: (sql) => c.query(sql) });
    console.log(`read-only session: ${ro}; licenses with a Stripe subscription: ${all}; subscriptions with more than one license: ${dups.length}`);
    for (const d of dups) {
      console.log(`\n${d.subscription}`);
      for (const l of d.licenses) console.log(`  license ${l.id}  ${l.email}  plan=${l.plan}  active=${l.active}  created=${new Date(l.created_at).toISOString()}`);
    }
    if (!dups.length) console.log("None — the index can be made as it is.");
    console.log(`\n(query: ${DUPLICATES_SQL.replace(/\s+/g, " ")})`);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
