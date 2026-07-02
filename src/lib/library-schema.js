'use strict';
// Ether v2 data architecture (spec §2.2): backend materialized library state.
// Single source of truth for the v2 library DDL — required by index.js schema-init (prod apply)
// AND by the scratch proof (pg-mem), so what we prove is exactly what we apply.
//
// All additive CREATE TABLE IF NOT EXISTS — safe/idempotent, touches nothing existing.

const LIBRARY_V2_DDL = [
  // Current library state per license — THIS is the source of truth (D2).
  `CREATE TABLE IF NOT EXISTS library_songs (
     license_key_id   INT NOT NULL REFERENCES licenses(id),
     content_hash     TEXT NOT NULL,
     title            TEXT NOT NULL,
     artist           TEXT,
     album            TEXT,
     duration_ms      INTEGER,
     ext              TEXT NOT NULL,
     size_bytes       BIGINT NOT NULL,
     source_folder    TEXT,
     original_name    TEXT,
     updated_at       TIMESTAMPTZ NOT NULL,
     updated_hlc      TEXT NOT NULL,
     snapshot_version BIGINT NOT NULL,
     PRIMARY KEY (license_key_id, content_hash)
   )`,

  // Per-license snapshot version, bumped on every write to library_songs.
  `CREATE TABLE IF NOT EXISTS library_snapshot_version (
     license_key_id INT PRIMARY KEY REFERENCES licenses(id),
     version        BIGINT NOT NULL DEFAULT 0,
     updated_at     TIMESTAMPTZ NOT NULL
   )`,

  // Short-lived deletion notices for online clients; GC'd by compaction (§5).
  `CREATE TABLE IF NOT EXISTS library_tombstones (
     license_key_id   INT NOT NULL REFERENCES licenses(id),
     content_hash     TEXT NOT NULL,
     deleted_at       TIMESTAMPTZ NOT NULL,
     snapshot_version BIGINT NOT NULL,
     PRIMARY KEY (license_key_id, content_hash)
   )`,

  // Change-stream lookups: /library/changes filters snapshot_version > N per license.
  `CREATE INDEX IF NOT EXISTS idx_library_songs_ver      ON library_songs(license_key_id, snapshot_version)`,
  `CREATE INDEX IF NOT EXISTS idx_library_tombstones_ver ON library_tombstones(license_key_id, snapshot_version)`,
];

module.exports = { LIBRARY_V2_DDL };
