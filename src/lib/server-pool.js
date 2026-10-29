'use strict';
// THE SERVER'S DATABASE POOL. Run as the server (`node src/index.js`), index.js makes its pool exactly as it always has:
// Postgres at DATABASE_URL. A test hands in its own pool (pg-mem) with useTestPool() BEFORE it requires index.js, so the
// real routes and the real boot schema run against a database that lives only in the test. Nothing else changes.
const { Pool } = require("pg");

let testPool = null;
/** Tests only: the pool index.js will use when it is next loaded. */
function useTestPool(pool) { testPool = pool; }
function makePool() {
  return testPool || new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

module.exports = { useTestPool, makePool };
