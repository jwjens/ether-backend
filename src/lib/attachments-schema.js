'use strict';
// Ether v2 subscription model (spec CORE VISION): surfaces SUBSCRIBE to cloud-defined stations.
// station_attachments records which surface (machine/client id) attaches to which station, in which
// role. Playout is a CLAIM — EXCLUSIVE per station (one playout surface at a time), claimable and
// releasable. This is the rail for studio handoff + cloud playout; only desktop-playout is built now.
//
// Shared DDL so the pg-mem proof runs the exact statements index.js applies. Additive/idempotent.

const ATTACHMENTS_DDL = [
  `CREATE TABLE IF NOT EXISTS station_attachments (
     id             BIGSERIAL PRIMARY KEY,
     license_key_id INT  NOT NULL REFERENCES licenses(id),
     surface_id     TEXT NOT NULL,                 -- machine/client id (D2: == client_identity.client_id)
     machine_name   TEXT,                          -- denormalized for a clean "held by <name>" message
     station_uuid   TEXT NOT NULL,                 -- stable station identity (matches stations.uuid)
     role           TEXT NOT NULL DEFAULT 'playout' CHECK (role IN ('playout','monitor')),
     created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (license_key_id, surface_id, station_uuid, role)
   )`,
  // D3: EXACTLY ONE playout surface per (license, station). This is the exclusivity guarantee.
  `CREATE UNIQUE INDEX IF NOT EXISTS station_attachments_one_playout
     ON station_attachments (license_key_id, station_uuid) WHERE role = 'playout'`,
  // Fast "what does this surface run?" lookup on sign-in.
  `CREATE INDEX IF NOT EXISTS idx_attachments_surface
     ON station_attachments (license_key_id, surface_id)`,
];

module.exports = { ATTACHMENTS_DDL };
