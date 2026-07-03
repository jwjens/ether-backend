'use strict';
// src/routes/attachments.js — Ether v2 station attachments (subscription model).
//   POST /account/attach  — a surface claims a station in a role (default 'playout')
//   POST /account/detach  — release
// Playout is EXCLUSIVE per station (D3). A playout claim held by ANOTHER surface fails gracefully:
// 409 { error:'playout_held', holder:{surface_id, machine_name} } — clean message, no transfer flow yet.
// Core logic exported as plain fns so it's provable on pg-mem without HTTP.

// Attach surfaceId → stationUuid in role. For playout, refuse if another surface already holds it.
async function attachSurface(pool, { licenseKeyId, surfaceId, machineName = null, stationUuid, role = 'playout' }) {
  if (role === 'playout') {
    const held = await pool.query(
      `SELECT surface_id, machine_name FROM station_attachments
        WHERE license_key_id = $1 AND station_uuid = $2 AND role = 'playout'`, [licenseKeyId, stationUuid]);
    if (held.rows.length && held.rows[0].surface_id !== surfaceId) {
      return { ok: false, code: 'playout_held', holder: { surface_id: held.rows[0].surface_id, machine_name: held.rows[0].machine_name } };
    }
  }
  const up = await pool.query(
    `INSERT INTO station_attachments (license_key_id, surface_id, machine_name, station_uuid, role, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5, now(), now())
     ON CONFLICT (license_key_id, surface_id, station_uuid, role)
       DO UPDATE SET machine_name = EXCLUDED.machine_name, updated_at = now()
     RETURNING id, surface_id, machine_name, station_uuid, role`, [licenseKeyId, surfaceId, machineName, stationUuid, role]);
  return { ok: true, attachment: up.rows[0] };
}

async function detachSurface(pool, { licenseKeyId, surfaceId, stationUuid, role = null }) {
  const params = role ? [licenseKeyId, surfaceId, stationUuid, role] : [licenseKeyId, surfaceId, stationUuid];
  const r = await pool.query(
    `DELETE FROM station_attachments WHERE license_key_id=$1 AND surface_id=$2 AND station_uuid=$3${role ? ' AND role=$4' : ''}`, params);
  return { ok: true, deleted: r.rowCount };
}

// What stations does THIS surface run (for sign-in provisioning)?
async function attachmentsForSurface(pool, licenseKeyId, surfaceId) {
  const r = await pool.query(
    `SELECT station_uuid, role FROM station_attachments WHERE license_key_id=$1 AND surface_id=$2 ORDER BY created_at`,
    [licenseKeyId, surfaceId]);
  return r.rows;
}

function makeAttachmentsRouter(pool, lookupLicense) {
  const express = require('express');
  const router = express.Router();

  router.post('/attach', async (req, res) => {
    try {
      const { license_key, surface_id, machine_name, station_uuid, role } = req.body || {};
      if (!surface_id || !station_uuid) return res.status(400).json({ error: 'surface_id and station_uuid required' });
      const lic = await lookupLicense(license_key);
      if (!lic) return res.status(401).json({ error: 'invalid_license_key' });
      const r = await attachSurface(pool, { licenseKeyId: lic.id, surfaceId: surface_id, machineName: machine_name || null, stationUuid: station_uuid, role: role || 'playout' });
      if (!r.ok && r.code === 'playout_held') return res.status(409).json({ error: 'playout_held', holder: r.holder });
      if (!r.ok) return res.status(500).json({ error: r.error || 'server_error' });
      res.json({ ok: true, attachment: r.attachment });
    } catch (e) { console.error('[account/attach]', e.message); res.status(500).json({ error: 'server_error' }); }
  });

  router.post('/detach', async (req, res) => {
    try {
      const { license_key, surface_id, station_uuid, role } = req.body || {};
      if (!surface_id || !station_uuid) return res.status(400).json({ error: 'surface_id and station_uuid required' });
      const lic = await lookupLicense(license_key);
      if (!lic) return res.status(401).json({ error: 'invalid_license_key' });
      res.json(await detachSurface(pool, { licenseKeyId: lic.id, surfaceId: surface_id, stationUuid: station_uuid, role: role || null }));
    } catch (e) { console.error('[account/detach]', e.message); res.status(500).json({ error: 'server_error' }); }
  });

  return router;
}

module.exports = makeAttachmentsRouter;
module.exports.attachSurface = attachSurface;
module.exports.detachSurface = detachSurface;
module.exports.attachmentsForSurface = attachmentsForSurface;
