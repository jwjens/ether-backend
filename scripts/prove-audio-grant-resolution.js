'use strict';
// scripts/prove-audio-grant-resolution.js
//
// Proves the cross-license AUDIO resolution boundary used by /audio/download-url and
// /audio/list. Exercises the REAL shared resolver (src/lib/libraryGrants.js) against an
// in-memory grants table (pg-mem) and a MOCK R2 (a Set of object keys) — no production R2
// or DB touched. Replicates each endpoint's exact key-selection so the result is what the
// live endpoints would sign/list.
//
// Run:  node scripts/prove-audio-grant-resolution.js

const { newDb } = require('pg-mem');
const { grantedOwnerLicenseIds, resolveAudioPrefixId } = require('../src/lib/libraryGrants');

const OWNER = 1, GRANTEE = 2, UNGRANTED = 3;

// MOCK R2: which object keys exist. Owner has a song; grantee has its own; nothing under 3/.
const R2 = new Set([`${OWNER}/owner-only.mp3`, `${GRANTEE}/grantee-own.mp3`]);
const objectExists  = async (key)    => R2.has(key);
const listForPrefix = async (prefix) => [...R2].filter(k => k.startsWith(prefix));

// pg-mem grants table + the one grant under test (owner 1 → grantee 2).
const db = newDb();
db.public.none(`CREATE TABLE library_grants (
  id SERIAL PRIMARY KEY, owner_license_id INTEGER, grantee_license_id INTEGER, revoked_at TIMESTAMPTZ)`);
const { Pool } = db.adapters.createPg();
const pool = new Pool();

// Exact replica of the /audio/download-url prefix decision (index.js).
async function downloadSignedKey(callerId, file_key) {
  let prefixId = callerId;
  const ownerIds = await grantedOwnerLicenseIds(pool, callerId);
  if (ownerIds.length > 0) {
    const resolved = await resolveAudioPrefixId(objectExists, callerId, ownerIds, file_key);
    if (resolved != null) prefixId = resolved;
  }
  const key = `${prefixId}/${file_key}`;
  return { prefixId, key, existsInR2: R2.has(key) };
}

// Exact replica of the /audio/list union (index.js).
async function listKeys(callerId) {
  const ownerIds = await grantedOwnerLicenseIds(pool, callerId);
  const prefixes = [callerId, ...ownerIds].map(id => `${id}/`);
  const set = new Set();
  for (const p of prefixes) for (const k of await listForPrefix(p)) if (k.startsWith(p)) set.add(k.slice(p.length));
  return [...set].sort();
}

(async () => {
  await pool.query(`INSERT INTO library_grants (owner_license_id, grantee_license_id) VALUES ($1,$2)`, [OWNER, GRANTEE]);

  const checks = [];
  const pass = (label, cond, detail) => checks.push({ label, ok: !!cond, detail });

  // A. GRANTEE downloading the OWNER-only file → resolves to the OWNER's prefix and exists.
  const a = await downloadSignedKey(GRANTEE, 'owner-only.mp3');
  pass(`grantee download "owner-only.mp3" resolves to OWNER prefix → ${a.key}`,
       a.key === `${OWNER}/owner-only.mp3` && a.existsInR2, JSON.stringify(a));

  // B. UNGRANTED license downloading the same file → CANNOT reach the owner's object.
  const b = await downloadSignedKey(UNGRANTED, 'owner-only.mp3');
  const bResolved = await resolveAudioPrefixId(objectExists, UNGRANTED, [], 'owner-only.mp3');
  pass(`ungranted download "owner-only.mp3" stays on OWN prefix → ${b.key} (NOT owner's, does not exist)`,
       b.key === `${UNGRANTED}/owner-only.mp3` && b.key !== `${OWNER}/owner-only.mp3` && b.existsInR2 === false,
       JSON.stringify(b));
  pass('ungranted resolver returns null (file found under no reachable prefix)', bResolved === null);

  // C. GRANTEE downloading its OWN file → caller-first probe keeps it on its own prefix.
  const c = await downloadSignedKey(GRANTEE, 'grantee-own.mp3');
  pass(`grantee download own file resolves to OWN prefix → ${c.key}`,
       c.key === `${GRANTEE}/grantee-own.mp3` && c.existsInR2, JSON.stringify(c));

  // D. GRANTEE /audio/list → sees its own file AND the owner's catalog.
  const dList = await listKeys(GRANTEE);
  pass(`grantee list = ${JSON.stringify(dList)} (own + owner's catalog)`,
       dList.length === 2 && dList.includes('owner-only.mp3') && dList.includes('grantee-own.mp3'));

  // E. UNGRANTED /audio/list → owner's catalog is NOT visible.
  const eList = await listKeys(UNGRANTED);
  pass(`ungranted list = ${JSON.stringify(eList)} (NO owner catalog)`,
       eList.length === 0 && !eList.includes('owner-only.mp3'));

  console.log('=== AUDIO GRANT RESOLUTION ASSERTIONS ===');
  let allOk = true;
  for (const c of checks) { console.log(`   ${c.ok ? 'PASS' : 'FAIL'}  ${c.label}`); if (!c.ok) { allOk = false; if (c.detail) console.log(`         detail: ${c.detail}`); } }
  console.log('\n=== RESULT:', allOk ? 'AUDIO BOUNDARY HOLDS — grant grants read, absence denies ✅' : 'BOUNDARY VIOLATED ❌', '===');
  process.exit(allOk ? 0 : 1);
})().catch(e => { console.error('PROOF HARNESS ERROR:', e); process.exit(2); });
