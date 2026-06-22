'use strict';
// src/routes/sync.js — Ether sync endpoints per protocol doc §17–§18.
//
// Mounted at /sync in index.js behind requireLicense middleware.
// Auth is fully enforced at mount point — these handlers trust req.license.
//
// POST /sync/mutations   — receive push batch from client [§17]
// GET  /sync/mutations   — deliver mutations to client [§18]
//
// Backend retention policy: mutations are kept forever [§22 N-119].
// Idempotency: ON CONFLICT (license_key_id, id) DO NOTHING [N-100].
// Defense-in-depth: excluded tables rejected even if client sends them [N-101].

const express = require('express');
const { grantedOwnerLicenseIds } = require('../lib/libraryGrants');

// ── Server HLC identity ────────────────────────────────────────────────────────
//
// server_hlc in pull responses uses HLC format: <wall_ms>:<logical>:<client_id>
// per N-38. The server emits logical=0 per response; clients only log server_hlc
// and take no action on it [N-98], so monotonicity across responses is not required.
//
// Identity rules:
//   - This UUID must be stable and unique per backend instance.
//   - If horizontal scaling is ever introduced, each instance MUST have its own
//     SYNC_SERVER_ID — shared IDs would make server_hlc values non-unique across
//     instances, violating the HLC client_id uniqueness assumption.
//   - For v1, consider maintaining real server-side HLC state so the logical
//     counter advances monotonically within a process lifetime rather than
//     resetting to 0 on every response.
let SERVER_CLIENT_ID;
if (process.env.SYNC_SERVER_ID) {
  SERVER_CLIENT_ID = process.env.SYNC_SERVER_ID;
} else if (process.env.NODE_ENV === 'production') {
  throw new Error(
    '[sync] SYNC_SERVER_ID required in production — ' +
    'set this env var to a stable UUID for this backend instance'
  );
} else {
  SERVER_CLIENT_ID = require('crypto').randomUUID();
  console.warn(
    '[sync] SYNC_SERVER_ID not set — using auto-generated server ID:',
    SERVER_CLIENT_ID,
    '(set SYNC_SERVER_ID to suppress this warning)'
  );
}

const MAX_BATCH = 500;
const VALID_OPS = new Set(['insert', 'update', 'delete', 'checkpoint']);

// Tables the backend refuses to store, regardless of what the client sends.
// These should never appear in push payloads (filtered client-side), but this
// is a second line of defense [N-101].
// generated_schedule is DERIVED, regenerable playout data — each day's generation
// emits thousands of rows. Peer-syncing it flooded the table (167k rows / ~140MB in
// one day) and filled the volume. Each install regenerates it locally from the synced
// clocks + rules, so it must never travel over peer-sync [N-120].
const BACKEND_EXCLUDED = new Set(['install_secrets_kv', 'monitor_routing', 'generated_schedule']);

// ── Library grants (master-catalog cross-license read access) ──────────────────
// GRANTABLE_LIBRARY_TABLES is THE ISOLATION BOUNDARY for cross-license library sharing:
// the ONLY install-scope tables a grantee may inherit from a granted owner. songs/artists/
// albums = the music catalog; nothing else crosses the license line — not install_config_kv,
// not secrets, not station-scoped programming. Do NOT widen without re-proving the boundary
// (scripts/prove-library-grant-isolation.js).
const GRANTABLE_LIBRARY_TABLES = ['songs', 'artists', 'albums'];

// grantedOwnerLicenseIds() lives in ../lib/libraryGrants (shared with the /audio/* endpoints)
// so the grant rule has exactly one definition. Returns [] when there are no active grants →
// the sync UNION below matches nothing, so non-grantees are unaffected.

/**
 * @param {import('pg').Pool} pool
 * @returns {import('express').Router}
 */
function makeSyncRouter(pool) {
  const router = express.Router();

  // ── POST /sync/mutations — push ─────────────────────────────────────────────

  router.post('/mutations', async (req, res) => {
    try {
      // Plan A read-only half: members may PULL but never PUSH. Member writes are a separate,
      // explicitly-gated path (not built until confirmed). x-license-key installs are unaffected.
      if (req.isMember) return res.status(403).json({ error: 'member_write_disabled' });

      const { client_id, station_id = null, batch } = req.body;

      if (!client_id || typeof client_id !== 'string')
        return res.status(400).json({ error: 'Missing or invalid client_id' });
      if (!Array.isArray(batch))
        return res.status(400).json({ error: 'batch must be an array' });
      if (batch.length > MAX_BATCH)
        return res.status(400).json({ error: `Batch too large — max ${MAX_BATCH} per push [N-93]` });

      const accepted = [];
      const rejected = [];

      for (const m of batch) {
        if (!m?.id || !m.table_name || !m.op || !m.row_id || !m.hlc || !m.created_at) {
          rejected.push({ id: m?.id ?? null, reason: 'missing required fields' });
          continue;
        }
        if (BACKEND_EXCLUDED.has(m.table_name)) {
          rejected.push({ id: m.id, reason: 'table excluded from sync [N-101]' });
          continue;
        }
        if (!VALID_OPS.has(m.op)) {
          rejected.push({ id: m.id, reason: 'invalid op: ' + m.op });
          continue;
        }
        if (typeof m.schema_version !== 'number') {
          rejected.push({ id: m.id, reason: 'schema_version must be a number' });
          continue;
        }

        try {
          await pool.query(`
            INSERT INTO mutations (
              id, client_id, station_id, operator_id, license_key_id,
              table_name, row_id, op,
              payload_before, payload_after,
              created_at, hlc, parent_mutation_id,
              schema_version, conflict_resolution
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
            ON CONFLICT (license_key_id, id) DO NOTHING
          `, [
            m.id,
            m.client_id ?? client_id,
            m.station_id ?? station_id,
            m.operator_id ?? null,
            req.license.id,
            m.table_name,
            m.row_id,
            m.op,
            m.payload_before != null ? JSON.stringify(m.payload_before) : null,
            m.payload_after  != null ? JSON.stringify(m.payload_after)  : null,
            m.created_at,
            m.hlc,
            m.parent_mutation_id ?? null,
            m.schema_version,
            m.conflict_resolution != null ? JSON.stringify(m.conflict_resolution) : null,
          ]);
          accepted.push(m.id);
        } catch (e) {
          console.error('[sync/push] row insert error:', e.message);
          rejected.push({ id: m.id, reason: 'server error' });
        }
      }

      console.log(
        `[sync/push] client=${client_id.slice(0, 8)} ` +
        `accepted=${accepted.length} rejected=${rejected.length}`
      );
      res.json({ accepted, rejected });
    } catch (e) {
      console.error('[sync/push]', e.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ── GET /sync/mutations — pull ──────────────────────────────────────────────

  router.get('/mutations', async (req, res) => {
    try {
      const { client_id, station_id = null, since_seq = '0' } = req.query;

      if (!client_id || typeof client_id !== 'string')
        return res.status(400).json({ error: 'Missing client_id' });

      const sinceSeq = parseInt(since_seq, 10) || 0;
      const sid      = station_id || null;

      // Library grants: owner licenses whose music catalog THIS license may READ (master-
      // catalog cross-license access). Empty for the vast majority of installs → the UNION
      // branch below matches nothing and behavior is unchanged. The ONLY install-scope rows
      // that cross the license line are GRANTABLE_LIBRARY_TABLES — never config, secrets, or
      // station-scoped rows. This UNION is the isolation boundary; the table whitelist is its
      // sole guard (proven in scripts/prove-library-grant-isolation.js).
      const ownerIds = await grantedOwnerLicenseIds(pool, req.license.id);

      // Return up to 500 mutations the client has not yet seen, scoped to this
      // license [tenant isolation]. Own-client mutations are included — the
      // client deduplicates by id locally (idempotency check, Step 1 of §19).
      // Scope filter:
      //   - if station_id provided: return station-scoped + install-scoped (station_id IS NULL)
      //   - if station_id absent:   return install-scoped only
      // PLUS (UNION): granted owners' install-scope LIBRARY rows only (table-whitelisted).
      let rows;
      if (sid) {
        const result = await pool.query(`
          SELECT
            server_seq, id, client_id, station_id, operator_id,
            table_name, row_id, op,
            payload_before, payload_after,
            created_at, hlc, parent_mutation_id,
            schema_version, conflict_resolution
          FROM mutations
          WHERE server_seq > $1
            AND license_key_id = $2
            AND (station_id = $3 OR station_id IS NULL)
          UNION ALL
          SELECT
            server_seq, id, client_id, station_id, operator_id,
            table_name, row_id, op,
            payload_before, payload_after,
            created_at, hlc, parent_mutation_id,
            schema_version, conflict_resolution
          FROM mutations
          WHERE server_seq > $1
            AND license_key_id = ANY($4::int[])
            AND station_id IS NULL
            AND table_name = ANY($5::text[])
          ORDER BY server_seq ASC
          LIMIT 500
        `, [sinceSeq, req.license.id, sid, ownerIds, GRANTABLE_LIBRARY_TABLES]);
        rows = result.rows;
      } else {
        const result = await pool.query(`
          SELECT
            server_seq, id, client_id, station_id, operator_id,
            table_name, row_id, op,
            payload_before, payload_after,
            created_at, hlc, parent_mutation_id,
            schema_version, conflict_resolution
          FROM mutations
          WHERE server_seq > $1
            AND license_key_id = $2
            AND station_id IS NULL
          UNION ALL
          SELECT
            server_seq, id, client_id, station_id, operator_id,
            table_name, row_id, op,
            payload_before, payload_after,
            created_at, hlc, parent_mutation_id,
            schema_version, conflict_resolution
          FROM mutations
          WHERE server_seq > $1
            AND license_key_id = ANY($3::int[])
            AND station_id IS NULL
            AND table_name = ANY($4::text[])
          ORDER BY server_seq ASC
          LIMIT 500
        `, [sinceSeq, req.license.id, ownerIds, GRANTABLE_LIBRARY_TABLES]);
        rows = result.rows;
      }

      const mutations = rows.map(r => ({
        id:                  r.id,
        client_id:           r.client_id,
        station_id:          r.station_id,
        operator_id:         r.operator_id,
        table_name:          r.table_name,
        row_id:              r.row_id,
        op:                  r.op,
        payload_before:      r.payload_before,   // pg returns JSONB as parsed object
        payload_after:       r.payload_after,
        created_at:          r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        hlc:                 r.hlc,
        parent_mutation_id:  r.parent_mutation_id,
        schema_version:      r.schema_version,
        conflict_resolution: r.conflict_resolution,
      }));

      const maxSeq = rows.length > 0
        ? Number(rows[rows.length - 1].server_seq)
        : sinceSeq;

      const serverHlc = `${Date.now()}:0:${SERVER_CLIENT_ID}`;

      console.log(
        `[sync/pull] client=${client_id.slice(0, 8)} ` +
        `since_seq=${sinceSeq} returned=${mutations.length}`
      );
      res.json({ mutations, server_seq: maxSeq, server_hlc: serverHlc });
    } catch (e) {
      console.error('[sync/pull]', e.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ── GET /sync/pending-count — backlog count for OnboardingFlow Screen 4 ─
  //
  // Returns the number of mutations the client has not yet pulled, grouped
  // by table_name. WHERE clauses mirror /sync/mutations (GET) exactly so the
  // count never diverges from what pull will deliver — including own-client
  // mutations (the client deduplicates by id locally; the count must include
  // them or "X of Y" progress will have X exceed Y).
  //
  // Single GROUP BY query; total_remaining is summed in JS. No new index
  // needed — the existing idx_mutations_sta_seq (and idx_mutations_seq for
  // the install-only branch) cover the WHERE. If a real customer ever hits
  // 50k+ queued mutations and this gets slow, a partial composite index
  // (license_key_id, server_seq) INCLUDE (table_name) is the optimization.
  //
  // Error contract:
  //   400 Missing client_id          — query param missing (mirrors /sync/pull)
  //   401 missing_license_key / invalid_license_key — handled by requireLicense
  //   500 Server error               — query failure

  router.get('/pending-count', async (req, res) => {
    try {
      const { client_id, station_id = null, since_seq = '0' } = req.query;

      if (!client_id || typeof client_id !== 'string')
        return res.status(400).json({ error: 'Missing client_id' });

      const sinceSeq = parseInt(since_seq, 10) || 0;
      const sid      = station_id || null;

      let rows;
      if (sid) {
        const result = await pool.query(`
          SELECT table_name, COUNT(*)::int AS n
          FROM mutations
          WHERE server_seq > $1
            AND license_key_id = $2
            AND (station_id = $3 OR station_id IS NULL)
          GROUP BY table_name
        `, [sinceSeq, req.license.id, sid]);
        rows = result.rows;
      } else {
        const result = await pool.query(`
          SELECT table_name, COUNT(*)::int AS n
          FROM mutations
          WHERE server_seq > $1
            AND license_key_id = $2
            AND station_id IS NULL
          GROUP BY table_name
        `, [sinceSeq, req.license.id]);
        rows = result.rows;
      }

      const per_table = {};
      let total_remaining = 0;
      for (const r of rows) {
        per_table[r.table_name] = r.n;
        total_remaining += r.n;
      }

      console.log(
        `[sync/pending-count] client=${client_id.slice(0, 8)} ` +
        `since_seq=${sinceSeq} total=${total_remaining} tables=${Object.keys(per_table).length}`
      );
      res.json({ total_remaining, per_table });
    } catch (e) {
      console.error('[sync/pending-count]', e.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
}

module.exports = makeSyncRouter;
