'use strict';
// src/routes/library.js — Ether v2 library endpoints (spec §3). Mounted at /library.
//
//   GET    /library/snapshot                — full current library state for the license (D2 bootstrap)
//   GET    /library/changes?since_version=N — upserts + deletes since version N (the tail)
//   POST   /library/songs                   — upsert one song (bumps version, stamps snapshot_version)
//   DELETE /library/songs/:content_hash     — delete (removes row, writes tombstone, bumps version)
//
// Grants: reads honor library_grants exactly like /sync — a grantee sees its own library UNION the
// libraries of the owners it may read (grantedOwnerLicenseIds). Writes only ever touch the caller's
// OWN license. Core logic is exported as plain functions so it can be proven on pg-mem without HTTP.

const { grantedOwnerLicenseIds } = require('../lib/libraryGrants');

const SONG_COLS = `content_hash, title, artist, album, duration_ms, ext, size_bytes, source_folder, original_name`;

// Own license + owners it may read (for snapshot/changes UNION).
async function sourceLicenseIds(pool, licenseId) {
  const owners = await grantedOwnerLicenseIds(pool, licenseId);
  return [licenseId, ...owners];
}

// Current combined version = high-water mark across the source licenses' counters.
async function combinedVersion(pool, ids) {
  const r = await pool.query(
    `SELECT COALESCE(MAX(version), 0) AS v FROM library_snapshot_version WHERE license_key_id = ANY($1::int[])`, [ids]);
  return Number(r.rows[0].v);
}

async function snapshotFor(pool, licenseId) {
  const ids = await sourceLicenseIds(pool, licenseId);
  const songs = (await pool.query(
    `SELECT ${SONG_COLS} FROM library_songs WHERE license_key_id = ANY($1::int[]) ORDER BY content_hash`, [ids])).rows;
  return { version: await combinedVersion(pool, ids), songs };
}

async function changesFor(pool, licenseId, since) {
  const ids = await sourceLicenseIds(pool, licenseId);
  const upserts = (await pool.query(
    `SELECT ${SONG_COLS}, snapshot_version FROM library_songs
      WHERE license_key_id = ANY($1::int[]) AND snapshot_version > $2 ORDER BY snapshot_version`, [ids, since])).rows;
  const deletes = (await pool.query(
    `SELECT content_hash, snapshot_version FROM library_tombstones
      WHERE license_key_id = ANY($1::int[]) AND snapshot_version > $2 ORDER BY snapshot_version`, [ids, since])).rows;
  return { version: await combinedVersion(pool, ids), upserts, deletes };
}

// Atomically bump the license's version and return the new value.
async function bumpVersion(client, licenseId) {
  const r = await client.query(
    `INSERT INTO library_snapshot_version (license_key_id, version, updated_at) VALUES ($1, 1, now())
     ON CONFLICT (license_key_id) DO UPDATE SET version = library_snapshot_version.version + 1, updated_at = now()
     RETURNING version`, [licenseId]);
  return Number(r.rows[0].version);
}

async function upsertSong(pool, licenseId, s) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const version = await bumpVersion(client, licenseId);
    await client.query(
      `INSERT INTO library_songs
         (license_key_id, content_hash, title, artist, album, duration_ms, ext, size_bytes, source_folder, original_name, updated_at, updated_hlc, snapshot_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), $11, $12)
       ON CONFLICT (license_key_id, content_hash) DO UPDATE SET
         title=EXCLUDED.title, artist=EXCLUDED.artist, album=EXCLUDED.album, duration_ms=EXCLUDED.duration_ms,
         ext=EXCLUDED.ext, size_bytes=EXCLUDED.size_bytes, source_folder=EXCLUDED.source_folder,
         original_name=EXCLUDED.original_name, updated_at=now(), updated_hlc=EXCLUDED.updated_hlc,
         snapshot_version=EXCLUDED.snapshot_version`,
      [licenseId, s.content_hash, s.title, s.artist ?? null, s.album ?? null, s.duration_ms ?? null,
       s.ext, s.size_bytes, s.source_folder ?? null, s.original_name ?? null, s.updated_hlc ?? '', version]);
    // Re-added content clears any prior tombstone for this license+hash.
    await client.query(`DELETE FROM library_tombstones WHERE license_key_id=$1 AND content_hash=$2`, [licenseId, s.content_hash]);
    await client.query('COMMIT');
    return { version };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

async function deleteSong(pool, licenseId, contentHash) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const version = await bumpVersion(client, licenseId);
    await client.query(`DELETE FROM library_songs WHERE license_key_id=$1 AND content_hash=$2`, [licenseId, contentHash]);
    await client.query(
      `INSERT INTO library_tombstones (license_key_id, content_hash, deleted_at, snapshot_version)
       VALUES ($1,$2, now(), $3)
       ON CONFLICT (license_key_id, content_hash) DO UPDATE SET deleted_at=now(), snapshot_version=EXCLUDED.snapshot_version`,
      [licenseId, contentHash, version]);
    await client.query('COMMIT');
    return { version };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

function makeLibraryRouter(pool) {
  const express = require('express');
  const router = express.Router();

  router.get('/snapshot', async (req, res) => {
    try {
      const { version, songs } = await snapshotFor(pool, req.license.id);
      res.json({ version, songs, generated_at: new Date().toISOString() });
    } catch (e) { console.error('[library/snapshot]', e.message); res.status(500).json({ error: 'server_error' }); }
  });

  router.get('/changes', async (req, res) => {
    try {
      const since = parseInt(req.query.since_version, 10) || 0;
      res.json(await changesFor(pool, req.license.id, since));
    } catch (e) { console.error('[library/changes]', e.message); res.status(500).json({ error: 'server_error' }); }
  });

  router.post('/songs', async (req, res) => {
    const s = req.body || {};
    if (!s.content_hash || !s.title || !s.ext || s.size_bytes == null)
      return res.status(400).json({ error: 'missing required fields: content_hash, title, ext, size_bytes' });
    try { res.json({ ok: true, ...(await upsertSong(pool, req.license.id, s)) }); }
    catch (e) { console.error('[library/songs upsert]', e.message); res.status(500).json({ error: 'server_error' }); }
  });

  router.delete('/songs/:content_hash', async (req, res) => {
    try { res.json({ ok: true, ...(await deleteSong(pool, req.license.id, req.params.content_hash)) }); }
    catch (e) { console.error('[library/songs delete]', e.message); res.status(500).json({ error: 'server_error' }); }
  });

  return router;
}

module.exports = makeLibraryRouter;
module.exports.snapshotFor = snapshotFor;
module.exports.changesFor = changesFor;
module.exports.upsertSong = upsertSong;
module.exports.deleteSong = deleteSong;
