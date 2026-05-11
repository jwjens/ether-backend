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
// Idempotency: UUID primary key; ON CONFLICT DO NOTHING [N-100].
// Defense-in-depth: excluded tables rejected even if client sends them [N-101].

const express = require('express');

const MAX_BATCH = 500;
const VALID_OPS = new Set(['insert', 'update', 'delete', 'checkpoint']);

// Tables the backend refuses to store, regardless of what the client sends.
// These should never appear in push payloads (filtered client-side), but this
// is a second line of defense [N-101].
const BACKEND_EXCLUDED = new Set(['install_secrets_kv', 'monitor_routing']);

/**
 * @param {import('pg').Pool} pool
 * @returns {import('express').Router}
 */
function makeSyncRouter(pool) {
  const router = express.Router();

  // ── POST /sync/mutations — push ─────────────────────────────────────────────

  router.post('/mutations', async (req, res) => {
    try {
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
              id, client_id, station_id, actor_id,
              table_name, row_id, op,
              payload_before, payload_after,
              created_at, hlc, parent_mutation_id,
              schema_version, conflict_resolution
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
            ON CONFLICT (id) DO NOTHING
          `, [
            m.id,
            m.client_id ?? client_id,
            m.station_id ?? station_id,
            m.actor_id   ?? null,
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

      // Return up to 1000 mutations this client hasn't seen yet.
      // Excludes the requesting client's own mutations (they're already local).
      // Scope filter:
      //   - if station_id provided: return station-scoped + install-scoped (station_id IS NULL)
      //   - if station_id absent:   return install-scoped only
      let rows;
      if (sid) {
        const result = await pool.query(`
          SELECT
            server_seq, id, client_id, station_id, actor_id,
            table_name, row_id, op,
            payload_before, payload_after,
            created_at, hlc, parent_mutation_id,
            schema_version, conflict_resolution
          FROM mutations
          WHERE server_seq > $1
            AND client_id != $2
            AND (station_id = $3 OR station_id IS NULL)
          ORDER BY server_seq ASC
          LIMIT 1000
        `, [sinceSeq, client_id, sid]);
        rows = result.rows;
      } else {
        const result = await pool.query(`
          SELECT
            server_seq, id, client_id, station_id, actor_id,
            table_name, row_id, op,
            payload_before, payload_after,
            created_at, hlc, parent_mutation_id,
            schema_version, conflict_resolution
          FROM mutations
          WHERE server_seq > $1
            AND client_id != $2
            AND station_id IS NULL
          ORDER BY server_seq ASC
          LIMIT 1000
        `, [sinceSeq, client_id]);
        rows = result.rows;
      }

      const mutations = rows.map(r => ({
        id:                  r.id,
        client_id:           r.client_id,
        station_id:          r.station_id,
        actor_id:            r.actor_id,
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

      console.log(
        `[sync/pull] client=${client_id.slice(0, 8)} ` +
        `since_seq=${sinceSeq} returned=${mutations.length}`
      );
      res.json({ mutations, server_seq: maxSeq });
    } catch (e) {
      console.error('[sync/pull]', e.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
}

module.exports = makeSyncRouter;
