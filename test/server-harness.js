'use strict';
// THE REAL SERVER IN A TEST: src/index.js, its real routes and its real boot schema (initDB), on an in-memory Postgres
// (pg-mem), served on an ephemeral port. Nothing is mocked except what leaves the machine: email (recorded, never sent).
//
// pg-mem cannot run every statement production Postgres runs. Each gap is listed here, with the stand-in used INSIDE THE
// TEST ONLY; production runs the original statement. A statement pg-mem refuses that is not listed fails the harness.
const http = require("node:http");
const { newDb, DataType } = require("pg-mem");
const crypto = require("node:crypto");

// Fixed secrets so a test can mint the same tokens the server would.
const SECRETS = { JWT_SECRET: "test-jwt-secret", ADMIN_SECRET: "test-admin-secret", ETHER_PLATFORM_SECRET: "test-platform-secret" };
// Dummy R2 settings: signing an upload/download link is computed locally (no request leaves the machine), so routes
// that hand out R2 links run their real code in a test instead of answering 503 r2_not_configured.
const R2_TEST_ENV = { R2_ACCOUNT_ID: "testaccount", R2_ACCESS_KEY_ID: "test-access-key", R2_SECRET_ACCESS_KEY: "test-secret-key",
                      R2_BUCKET: "test-bucket", R2_PUBLIC_BUCKET: "test-public-bucket", R2_PUBLIC_BASE_URL: "https://r2.test.invalid" };

/** Statements pg-mem cannot run, and what the test runs instead. */
const PG_MEM_GAPS = [
  {
    // pg-mem has no `(VALUES …) AS v(col, …)` column-alias list. The six system positions are inserted one row at a time
    // instead, the rows read from the original statement so the seed data is exactly production's.
    why: "VALUES with a column-alias list (positions seed)",
    match: (sql) => /INSERT INTO positions \(account_id, key, label, rank, permissions, is_system\)\s+SELECT NULL, v\.key/.test(sql),
    run: async (q, sql) => {
      const rows = [...sql.matchAll(/\('([a-z_]+)','([^']+)',(\d+),'(\{[^']*\})'\)/g)];
      if (rows.length !== 6) throw new Error(`positions seed: expected 6 rows, read ${rows.length}`);
      for (const [, key, label, rank, perms] of rows) {
        const have = await q(`SELECT 1 FROM positions WHERE key = $1 AND account_id IS NULL AND deleted_at IS NULL`, [key]);
        if (!have.rows.length) await q(`INSERT INTO positions (account_id, key, label, rank, permissions, is_system) VALUES (NULL, $1, $2, $3, $4::jsonb, true)`, [key, label, Number(rank), perms]);
      }
      return { rows: [], rowCount: rows.length };
    },
  },
  {
    // pg-mem cannot resolve the outer table (`l.`) inside a correlated subquery. The platform license list is read row by
    // row instead: the same columns, each counted by its own simple query.
    why: "correlated subqueries (platform license list)",
    match: (sql) => /SELECT l\.id, l\.email, l\.plan, l\.active, l\.created_at, l\.key_prefix/.test(sql) && /FROM licenses l ORDER BY l\.created_at DESC/.test(sql),
    run: async (q) => {
      const lics = (await q(`SELECT * FROM licenses ORDER BY created_at DESC`)).rows;
      const rows = [];
      for (const l of lics) {
        const keys = [l.license_key, `lic-${l.id}`];
        const st = (await q(`SELECT name FROM stations WHERE license_key_id = $1 ORDER BY name`, [l.id])).rows.map(r => r.name);
        const acts = (await q(`SELECT last_seen, deauthorized_at FROM license_activations WHERE license_key = $1 OR license_key = $2`, keys)).rows;
        const seen = [l.last_validated, ...acts.map(a => a.last_seen)].filter(Boolean).map(d => new Date(d).getTime());
        rows.push({ id: l.id, email: l.email, plan: l.plan, active: l.active, created_at: l.created_at, key_prefix: l.key_prefix,
          last_validated: l.last_validated, seat_tier_id: l.seat_tier_id, expires_at: l.expires_at, has_stripe: l.stripe_subscription_id != null,
          last_seen: seen.length ? new Date(Math.max(...seen)) : null, stations: st.length, station_names: st,
          activations: acts.filter(a => a.deauthorized_at == null).length });
      }
      return { rows, rowCount: rows.length };
    },
  },
];

function registerFunctions(db) {
  // Functions production Postgres has and pg-mem lacks (real implementations, not stand-ins).
  db.public.registerFunction({ name: "random", returns: DataType.float, implementation: () => Math.random(), impure: true });
  // pg-mem cannot cast timestamptz to text, and production's one use is `clock_timestamp()::text`: returned as its text.
  db.public.registerFunction({ name: "clock_timestamp", returns: DataType.text, implementation: () => new Date().toISOString(), impure: true });
  db.public.registerFunction({ name: "md5", args: [DataType.text], returns: DataType.text,
    implementation: (s) => crypto.createHash("md5").update(String(s)).digest("hex") });
}

/** Boot the real server. Call once per test file (src/index.js is a module: one app per process). */
async function startServer() {
  for (const [k, v] of Object.entries(SECRETS)) process.env[k] = v;
  for (const [k, v] of Object.entries(R2_TEST_ENV)) if (!process.env[k]) process.env[k] = v;
  process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "re_test_never_sent";
  const db = newDb();
  registerFunctions(db);
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const raw = pool.query.bind(pool);
  pool.query = (sql, params) => {
    const text = typeof sql === "string" ? sql : sql && sql.text;
    const gap = text && PG_MEM_GAPS.find(g => g.match(text));
    return gap ? gap.run(raw, text) : raw(sql, params);
  };
  require("../src/lib/server-pool").useTestPool(pool);
  const srv = require("../src/index.js");
  // email leaves the machine: record it instead
  const emails = [];
  srv.resend.emails.send = async (msg) => { emails.push(msg); return { data: { id: `test-${emails.length}` }, error: null }; };
  await srv.initDB();
  const server = http.createServer(srv.app);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  /** HTTP call; returns { status, body }. opts: { headers, body }. */
  async function call(method, path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    let body;
    if (opts.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.body); }
    const res = await fetch(base + path, { method, headers, body, redirect: "manual" });
    const txt = await res.text();
    let json = null; try { json = JSON.parse(txt); } catch {}
    return { status: res.status, body: json, text: txt };
  }
  const close = () => new Promise(r => { server.close(r); server.closeAllConnections(); });
  return { app: srv.app, pool, db, base, call, emails, close, secrets: SECRETS };
}

module.exports = { startServer, PG_MEM_GAPS, SECRETS };
