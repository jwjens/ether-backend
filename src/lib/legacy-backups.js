'use strict';
// src/lib/legacy-backups.js — every query the LEGACY backup routes run over the Postgres `backups` table (H2,
// docs/h2-backup-scope-fix-plan.md in the desktop repo). The current cloud backup is R2 (/backup/upload-url,
// /backup/download-url) and is untouched; this is the older gzipped-JSON BYTEA store that desktops ≤ v4.4.26 still
// upload to and every desktop can still list, restore from and delete.
//
// THE TENANT BOUNDARY IS THE LICENSE. Every statement is scoped by backups.license_key = the caller's verified
// license key (requireLicense), never by anything in the request. `station_id` is only a LABEL inside that license:
// the desktop sends its "Station ID (your email)" box, and the server falls back to the license email — it was
// never a station. Before this, /backup/list and the Studio 30-backup rotation filtered on station_id alone, so a
// caller could list, and evict, another account's backups by naming their email.

const STUDIO_KEEP = 30;

/** The caller's legacy-backup tenant key, or null when the license has none (bcrypt-only, no plaintext key). */
function legacyKey(license) {
  return license && typeof license.license_key === "string" && license.license_key ? license.license_key : null;
}

/** The refusal every legacy route gives a license with no legacy storage (instead of an insert 500 / silent no-match). */
const NO_LEGACY_STORAGE = {
  status: 409,
  body: { error: "legacy_backup_unavailable", detail: "This license has no legacy backup storage; cloud backups use /backup/upload-url." },
};

/** The caller's backups, optionally narrowed to one label. stationId null = all of the caller's backups. */
async function listBackups(pool, licenseKey, stationId = null) {
  const params = [licenseKey, stationId];
  const where = `license_key = $1 AND ($2::text IS NULL OR station_id = $2)`;
  const { rows } = await pool.query(
    `SELECT id, filename, size_bytes, checksum, created_at, description
       FROM backups WHERE ${where} ORDER BY created_at DESC`, params);
  const { rows: [t] } = await pool.query(
    `SELECT COALESCE(SUM(size_bytes), 0) AS total FROM backups WHERE ${where}`, params);
  return { rows, total: Number(t.total) };
}

/**
 * Studio-plan rotation: make room for one more backup under (license, label) by evicting the caller's OWN oldest
 * rows. Deletes as many as needed (count - keep + 1) so a backlog above the cap clears in one go. Both the victim
 * SELECT and the DELETE are filtered by the caller's license: neither can match another license's row.
 * Returns the number of rows deleted.
 *
 * TWO STATEMENTS, not `DELETE ... WHERE id IN (SELECT ... LIMIT n)`: Postgres evaluates that subquery once, but
 * pg-mem (the test database) re-evaluates it while deleting from the same table and removes every row (probed:
 * 10 of 10 instead of 2). Picking the ids first gives the same answer on both, so the test runs production's SQL.
 */
async function rotateStudioBackups(pool, licenseKey, stationId, keep = STUDIO_KEEP) {
  const { rows: [{ count }] } = await pool.query(
    `SELECT COUNT(*) AS count FROM backups WHERE license_key = $1 AND station_id = $2`, [licenseKey, stationId]);
  const excess = Number(count) - keep + 1;
  if (excess <= 0) return 0;
  const victims = (await pool.query(
    `SELECT id FROM backups
      WHERE license_key = $1 AND station_id = $2
      ORDER BY created_at ASC, id ASC
      LIMIT $3`,
    [licenseKey, stationId, excess])).rows.map(r => r.id);
  if (!victims.length) return 0;
  const list = victims.map((_, i) => `$${i + 2}`).join(", ");
  const r = await pool.query(`DELETE FROM backups WHERE license_key = $1 AND id IN (${list})`, [licenseKey, ...victims]);
  return r.rowCount;
}

async function insertBackup(pool, { licenseKey, stationId, filename, sizeBytes, checksum, data, description }) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO backups (station_id, license_key, filename, size_bytes, checksum, data, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
    [stationId, licenseKey, filename, sizeBytes, checksum, data, description]);
  return row;
}

/** One of the caller's backups (with data), or null — another license's id is indistinguishable from a missing one. */
async function getBackup(pool, licenseKey, id) {
  const { rows } = await pool.query(`SELECT * FROM backups WHERE id = $1 AND license_key = $2`, [id, licenseKey]);
  return rows[0] || null;
}

/** Delete one of the caller's backups. true if it existed and was the caller's. */
async function deleteBackup(pool, licenseKey, id) {
  const { rows } = await pool.query(`DELETE FROM backups WHERE id = $1 AND license_key = $2 RETURNING id`, [id, licenseKey]);
  return rows.length > 0;
}

module.exports = { STUDIO_KEEP, NO_LEGACY_STORAGE, legacyKey, listBackups, rotateStudioBackups, insertBackup, getBackup, deleteBackup };
