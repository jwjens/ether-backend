'use strict';
// src/lib/mutation-retention.js — every DELETE/COUNT the backend runs over the shared `mutations` log, in one place.
//
// RETENTION IS PER LICENSE (H3, docs/h3-prune-fix-plan.md in the desktop repo). We keep the LATEST mutation per
// (license_key_id, table_name, row_id) forever — the current state a fresh device of THAT account needs — and drop
// that account's own superseded history older than a recent buffer.
//
// The original prune grouped by (table_name, row_id) across ALL licenses, on the belief that row ids are globally
// unique UUIDs. They are not a tenant boundary: push stores whatever row_id the client sends (routes/sync.js), row
// uuids are published (jukebox pool), clone-programming copies the owner's uuids into a grantee's install, and every
// checkpoint shares ('__checkpoint__',''). So one account's newer write could delete another account's latest row.
// Grouping by license means an account's log can only ever be thinned by that account's own newer writes.
//
// The station-delete purge lives here too because it is the other DELETE over the shared log, and it carried the
// same defect: it matched on station uuid alone, so deleting your station also deleted any other license's rows
// that named that uuid.
//
// SQL SHAPE: `DELETE ... WHERE server_seq IN (subquery)` and a JS-computed cutoff, not `DELETE ... USING` and
// `$1::int * INTERVAL`. Both are equally correct on Postgres, but pg-mem (the test database) cannot parse the former
// or evaluate the latter, and the test must run the exact SQL production runs. server_seq is the table's primary key.

/** The retention cutoff: rows received before this may be pruned (if superseded). */
function cutoff(bufferDays, now = Date.now()) {
  return new Date(now - Number(bufferDays) * 86400000);
}

// The superseded rows: every row below its (license, table, row) group's newest server_seq, older than the cutoff.
// Shared by the prune and the dry-run count so the two can never disagree.
const SUPERSEDED_FROM = `
  FROM mutations m
  JOIN (SELECT license_key_id, table_name, row_id, MAX(server_seq) AS keep
          FROM mutations
         GROUP BY license_key_id, table_name, row_id) g
    ON  g.license_key_id = m.license_key_id
   AND  g.table_name     = m.table_name
   AND  g.row_id         = m.row_id
 WHERE m.server_seq  < g.keep
   AND m.received_at < $1::timestamptz`;

/** Delete superseded history, per license. Returns the number of rows deleted. */
async function pruneSupersededMutations(pool, bufferDays = 2, now = Date.now()) {
  const r = await pool.query(
    `DELETE FROM mutations WHERE server_seq IN (SELECT m.server_seq ${SUPERSEDED_FROM})`,
    [cutoff(bufferDays, now)],
  );
  return r.rowCount;
}

/** How many rows pruneSupersededMutations would delete with the same arguments (the platform dry run). */
async function countPrunable(pool, bufferDays = 2, now = Date.now()) {
  const r = await pool.query(`SELECT COUNT(*)::bigint AS would_delete ${SUPERSEDED_FROM}`, [cutoff(bufferDays, now)]);
  return r.rows[0].would_delete;
}

/** Total rows, and rows that are not the newest of their (license, table, row) group — db-stats' "superseded". */
async function supersededStats(pool) {
  const r = await pool.query(
    `SELECT COUNT(*)::bigint AS total,
            (COUNT(*) - COUNT(DISTINCT (license_key_id, table_name, row_id)))::bigint AS superseded
       FROM mutations`);
  return r.rows[0];
}

/**
 * Purge ONE license's mutation-log rows for a station it is deleting, so a stale desktop re-sync can't resurrect it.
 * Scoped to the owning license: rows another license pushed naming this uuid are that license's, and stay.
 * `db` is a pool or a transaction client.
 */
async function deleteStationMutations(db, licenseId, stationUuid) {
  const r = await db.query(
    `DELETE FROM mutations
      WHERE license_key_id = $1
        AND (station_id = $2 OR (table_name = 'stations' AND row_id = $2))`,
    [licenseId, stationUuid],
  );
  return r.rowCount;
}

module.exports = { cutoff, pruneSupersededMutations, countPrunable, supersededStats, deleteStationMutations };
