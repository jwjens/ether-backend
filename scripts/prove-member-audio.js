'use strict';
// scripts/prove-member-audio.js
//
// Proves the member-aware /audio/download-url authorization: a PD operating another account's station
// (member Bearer) gets a signed URL for that account's R2 prefix, while a plain license-key caller can
// NEVER address another account's prefix. Reproduces the endpoint's EXACT resolution branch (the same
// pattern prove-member-operate uses for the /sync gate) against a pg-mem memberships DB, with a stub
// signer that returns the resolved r2Key so the prefix decision is directly asserted.
//
// Run:  node scripts/prove-member-audio.js   (pure node — no electron/sqlite needed)

const express = require('express');
const { newDb } = require('pg-mem');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-secret-member-audio';
const RBAC_MEMBERSHIP_SYNC = true;
const OV_ACCT = 1, DJ_ACCT = 2;

const checks = []; const pass = (l, ok, d) => { checks.push(ok); console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${l}${d ? `  (${d})` : ''}`); };

(async () => {
  const pg = newDb();
  pg.public.none(`CREATE TABLE licenses (id SERIAL PRIMARY KEY, key TEXT)`);
  pg.public.none(`CREATE TABLE positions (id SERIAL PRIMARY KEY, key TEXT, rank INT, permissions JSONB)`);
  pg.public.none(`CREATE TABLE memberships (id SERIAL PRIMARY KEY, user_id INT, account_id INT, position_id INT, all_stations BOOLEAN, status TEXT, deleted_at TIMESTAMPTZ)`);
  const { Pool } = pg.adapters.createPg(); const pool = new Pool();
  await pool.query(`INSERT INTO licenses (id, key) VALUES (1,'lk-ov'),(2,'lk-dj')`);
  await pool.query(`INSERT INTO positions (id, key, rank, permissions) VALUES
    (1,'pd',70,'{"edit_programming":true}'), (2,'jock',20,'{"edit_programming":false}')`);
  // djdeniro (user 7) is an ACTIVE PD on OV (account 1), whole-account
  await pool.query(`INSERT INTO memberships (user_id, account_id, position_id, all_stations, status) VALUES (7,1,1,true,'active')`);
  // user 8 = invited-but-not-active PD on OV; user 9 = active JOCK (no edit) on OV
  await pool.query(`INSERT INTO memberships (user_id, account_id, position_id, all_stations, status) VALUES (8,1,1,true,'invited'),(9,1,2,true,'active')`);

  // ── helpers reproduced from index.js (not exported) ──
  const lookupLicense = async (k) => (await pool.query('SELECT id FROM licenses WHERE key = $1', [k])).rows[0] || null;
  const getMembership = async (userId, accountId) => (await pool.query(
    `SELECT m.id, m.account_id, m.all_stations, m.status, p.key AS position, p.permissions
       FROM memberships m JOIN positions p ON p.id = m.position_id
      WHERE m.user_id = $1 AND m.account_id = $2 AND m.deleted_at IS NULL`, [userId, accountId])).rows[0] || null;
  const memberCan = (m, perm) => !!(m && m.status === 'active' && m.permissions && m.permissions[perm] === true);

  // ── the endpoint's resolution branch, verbatim from src/index.js /audio/download-url ──
  const app = express(); app.use(express.json());
  app.post('/audio/download-url', async (req, res) => {
    const { license_key, file_key } = req.body || {};
    const rawKey = license_key && license_key.trim();
    const fileName = String(file_key || 'song.mp3');

    let prefixId = null, viaMember = false;
    if (rawKey) {
      const license = await lookupLicense(rawKey);
      if (!license) return res.status(401).json({ error: 'invalid_license_key' });
      prefixId = license.id;
    } else if (RBAC_MEMBERSHIP_SYNC) {
      const h = req.headers['authorization'] || '';
      if (h.startsWith('Bearer ')) {
        try {
          const p = jwt.verify(h.slice(7), JWT_SECRET);
          if ((p.typ === 'owner' || p.typ === 'user') && p.lk) {
            const m = await getMembership(p.uid, p.lk);
            if (m && m.status === 'active' && memberCan(m, 'edit_programming')) { prefixId = p.lk; viaMember = true; }
          }
        } catch (_) { /* fall through */ }
      }
    }
    if (prefixId == null) return res.status(401).json({ error: 'invalid_license_key' });
    // (library-grant probe omitted in the harness — irrelevant to the member-prefix assertion)
    res.json({ r2Key: `${prefixId}/${fileName}`, viaMember });
  });
  const server = app.listen(0); const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = async (body, token) => {
    const r = await fetch(`${baseUrl}/audio/download-url`, {
      method: 'POST',
      headers: token ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } : { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  const djMemberToken = jwt.sign({ typ: 'user', uid: 7, lk: OV_ACCT }, JWT_SECRET);   // switch-account token → OV
  const notMemberToken = jwt.sign({ typ: 'user', uid: 8, lk: OV_ACCT }, JWT_SECRET);  // invited, not active
  const jockToken      = jwt.sign({ typ: 'user', uid: 9, lk: OV_ACCT }, JWT_SECRET);  // active but no edit

  console.log('=== member-aware /audio/download-url ===');
  const r1 = await post({ file_key: 'ov-song.mp3' }, djMemberToken);
  pass('active PD member resolves to OV\'s R2 prefix', r1.status === 200 && r1.json.r2Key === `${OV_ACCT}/ov-song.mp3` && r1.json.viaMember === true, r1.json.r2Key);

  const r2 = await post({ license_key: 'lk-dj', file_key: 'ov-song.mp3' });
  pass('license-key caller can ONLY reach its OWN prefix (never OV)', r2.status === 200 && r2.json.r2Key === `${DJ_ACCT}/ov-song.mp3`, r2.json.r2Key);

  const r3 = await post({ file_key: 'ov-song.mp3' }, notMemberToken);
  pass('non-active membership is rejected (401)', r3.status === 401, `status=${r3.status}`);

  const r4 = await post({ file_key: 'ov-song.mp3' }, jockToken);
  pass('member without edit_programming is rejected (401)', r4.status === 401, `status=${r4.status}`);

  const r5 = await post({ file_key: 'ov-song.mp3' });
  pass('no credential is rejected (401)', r5.status === 401, `status=${r5.status}`);

  await new Promise(r => server.close(r));
  const ok = checks.every(Boolean);
  console.log(`\n=== RESULT: ${ok ? 'MEMBER-AUDIO authorization PROVEN ✅' : 'FAIL ❌'} ===`);
  process.exitCode = ok ? 0 : 1;   // let the loop drain (avoids the Windows libuv exit assertion)
})().catch(e => { console.error('PROOF HARNESS ERROR:', e); process.exitCode = 2; });
