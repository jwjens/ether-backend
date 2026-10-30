'use strict';
// THE STRANGER TEST (docs/link-access-audit-and-email-2026-10-28.md §4.3, desktop repo): two real accounts, A and B, each
// with a license, a verified user, an admin operator, a machine, a station and data in every account table. For an
// account route, B's credentials are aimed at A's resource — A's ids in the path, query and body — and the route must
// not hand B anything of A's or change anything of A's:
//   · leak   — the response contains an A-only marker (A's station uuid or name, key, email, machine, slug, …);
//   · change — a database row that belongs to A (by its license, station, user or machine) was added, changed or removed.
// A refusal passes; so does an answer about B's own data. Each B credential is tried in turn: license key, operator
// token, user token, owner token, Park session and Park key, so a route is tested with whatever credential it accepts.
//
// pg-mem stands in for Postgres (test/server-harness.js). Email is recorded, never sent; no Stripe/R2 secrets are set,
// so those calls fail closed inside the route (a 5xx with no A data passes — it is not a way in).
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const parkAuth = require("../../src/lib/park-auth");

async function seedAccount(pool, tag) {
  const q = (sql, p) => pool.query(sql, p).catch(e => {
    throw new Error(`seed [${sql.replace(/\s+/g, " ").slice(0, 50)}]: ${e.message.split("\n")[0]}`);
  });
  const key = `ETH-${tag}${tag}${tag}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  const email = `owner-${tag.toLowerCase()}-${crypto.randomBytes(3).toString("hex")}@stranger.test`;
  const lic = (await q(`INSERT INTO licenses (email, license_key, key_prefix, plan, active, account_name)
                        VALUES ($1,$2,$3,'station',true,$4) RETURNING id`, [email, key, key.slice(0, 12), `Acct ${tag}`])).rows[0].id;
  const uid = (await q(`INSERT INTO users (email, password_hash, email_verified, license_key_id, unsubscribe_token)
                        VALUES ($1,$2,true,$3,$4) RETURNING id`, [email, await bcrypt.hash("password-1", 4), lic, crypto.randomBytes(9).toString("hex")])).rows[0].id;
  const pinHash = "salt" + tag + ":" + crypto.createHash("sha256").update("salt" + tag + "1234").digest("hex");
  const opId = (await q(`INSERT INTO account_users (license_key_id, username, display_name, role, pin_hash)
                         VALUES ($1,'admin','Admin ${tag}','admin',$2) RETURNING id`, [lic, pinHash])).rows[0].id;
  const uuid = crypto.randomUUID();
  const stationName = `Station-${tag}-${crypto.randomBytes(3).toString("hex")}`;
  const stationId = (await q(`INSERT INTO stations (uuid, license_key_id, name) VALUES ($1,$2,$3) RETURNING id`, [uuid, lic, stationName])).rows[0].id;
  const slug = `slug-${tag.toLowerCase()}-${crypto.randomBytes(3).toString("hex")}`;
  await q(`INSERT INTO station_metadata (station_uuid, slug, display_name, public_enabled) VALUES ($1,$2,$3,true)`, [uuid, slug, stationName]);
  const machine = `machine-${tag}-${crypto.randomBytes(4).toString("hex")}`;
  await q(`INSERT INTO license_activations (license_key, machine_id, machine_name, os, station_uuid) VALUES ($1,$2,$3,'win32',$4)`, [key, machine, `PC ${tag}`, uuid]);
  const opsKey = crypto.randomBytes(16).toString("hex");
  await q(`INSERT INTO station_ops_token (station_uuid, token) VALUES ($1,$2)`, [uuid, opsKey]);
  const parkTok = crypto.randomBytes(16).toString("hex");
  await q(`INSERT INTO park_sessions (token_hash, license_key_id, username_lower, station_uuid, pin_fp) VALUES ($1,$2,'admin',$3,$4)`,
    [parkAuth.tokenHash(parkTok), lic, uuid, parkAuth.pinFingerprint(pinHash)]);
  const hash = crypto.createHash("sha256").update(`song-${tag}`).digest("hex");
  await q(`INSERT INTO library_songs (license_key_id, content_hash, title, artist, ext, size_bytes, updated_at, updated_hlc, snapshot_version)
           VALUES ($1,$2,$3,'Artist','mp3',1,now(),'1',1)`, [lic, hash, `Song ${tag}`]);
  const rowUuid = crypto.randomUUID();
  await q(`INSERT INTO station_cc_data (station_uuid, table_name, row_uuid, payload) VALUES ($1,'categories',$2,$3)`, [uuid, rowUuid, JSON.stringify({ name: `Cat ${tag}` })]);
  await q(`INSERT INTO staged_programming (station_uuid, table_name, row_uuid, payload) VALUES ($1,'categories',$2,$3)`, [uuid, rowUuid, JSON.stringify({ name: `Staged ${tag}` })]);
  await q(`INSERT INTO station_now_playing (station_uuid, playing, title, artist) VALUES ($1,true,$2,'Artist')`, [uuid, `Now ${tag}`]);
  const backupId = (await q(`INSERT INTO backups (station_id, license_key, filename, size_bytes, checksum, data) VALUES ($1,$2,$3,1,'sum',$4) RETURNING id`, [uuid, key, `backup-${tag}.db`, Buffer.from("x")])).rows[0].id;
  await q(`INSERT INTO mutations (id, client_id, station_id, table_name, row_id, op, payload_after, license_key_id, station_uuid, hlc, created_at, schema_version)
           VALUES ($1,$2,$3,'categories',$4,'create',$5,$6,$7,'1',now(),1)`, [crypto.randomUUID(), machine, stationId, rowUuid, JSON.stringify({ name: `Mut ${tag}` }), lic, uuid]);
  await q(`INSERT INTO jukebox_pool (slug, station_uuid, license_key_id, station_name, songs) VALUES ($1,$2,$3,$4,'[]')`, [slug, uuid, lic, stationName]);
  await q(`INSERT INTO link_account_keys (license_id, machine_id, machine_name, key_hex, key_id, fingerprint) VALUES ($1,$2,$3,$4,$5,$6)`,
    [lic, machine, `PC ${tag}`, crypto.randomBytes(32).toString("hex"), tag === "A" ? 101 : 202, `fp-${tag}`]);
  const sessionId = `sess-${tag}-${crypto.randomBytes(6).toString("hex")}`;
  await q(`INSERT INTO auth_sessions (id, user_id, machine_id, device_name, method, refresh_hash) VALUES ($1,$2,$3,'PC','password',$4)`,
    [sessionId, uid, machine, crypto.randomBytes(16).toString("hex")]);
  await q(`INSERT INTO station_attachments (license_key_id, surface_id, machine_name, station_uuid, role) VALUES ($1,$2,$3,$4,'playout')`, [lic, machine, `PC ${tag}`, uuid]);
  return { tag, key, email, lic, uid, opId, uuid, stationId, stationName, slug, machine, opsKey, parkTok, songHash: hash, rowUuid, backupId, sessionId };
}

function tokensFor(acct, secret) {
  const sign = (p) => jwt.sign(p, secret, { expiresIn: "1h" });
  return {
    operator: sign({ uid: acct.opId, lk: acct.lic, role: "admin", username: "admin" }),
    user: sign({ typ: "user", uid: acct.uid, lk: acct.lic }),
    owner: sign({ typ: "owner", uid: acct.uid, lk: acct.lic, role: "admin" }),
  };
}

/** Each way B can present itself. */
function credentialsOf(B, secret) {
  const t = tokensFor(B, secret);
  return [
    { name: "B license key", headers: { "x-license-key": B.key }, body: { license_key: B.key }, query: { key: B.key } },
    { name: "B operator token", headers: { authorization: `Bearer ${t.operator}` } },
    { name: "B user token", headers: { authorization: `Bearer ${t.user}` } },
    { name: "B owner token", headers: { authorization: `Bearer ${t.owner}` } },
    { name: "B Park session", headers: { "x-park-session": B.parkTok } },
    { name: "B Park key", headers: { "x-ops-token": B.opsKey } },
  ];
}

/** A's ids for each path parameter name. `:id` is the license id unless the route says otherwise (overrides). */
function paramsFor(A) {
  return { uuid: A.uuid, accountId: A.lic, id: A.lic, machineId: A.machine, slug: A.slug, key: A.key, content_hash: A.songHash,
           table: "categories", rowUuid: A.rowUuid, membershipId: 1, cmd_id: "cmd-a", token: A.parkTok, email: A.email, granteeId: A.lic };
}

/** A's ids in the fields routes read them from. B's own key rides along where a route takes a key in the body. */
function bodyFor(A) {
  return { station_uuid: A.uuid, stationUuid: A.uuid, uuid: A.uuid, station_id: A.stationId, stationId: A.stationId,
           account_id: A.lic, license_id: A.lic, license_key_id: A.lic, machine_id: A.machine, machineId: A.machine,
           content_hash: A.songHash, slug: A.slug, email: A.email, table: "categories", row_uuid: A.rowUuid, id: A.backupId,
           filename: `backup-${A.tag}.db`, username: "admin", pin: "1234", target: A.uuid };
}

function markersOf(A) {
  return [A.uuid, A.stationName, A.key, A.email, A.machine, A.opsKey, A.songHash, A.rowUuid, `Song ${A.tag}`, `Cat ${A.tag}`,
          `Staged ${A.tag}`, `Now ${A.tag}`, `Mut ${A.tag}`, `backup-${A.tag}.db`, `Admin ${A.tag}`, `fp-${A.tag}`];
}

/** Does this row belong to A? By license, station, user, machine or key. */
function belongsTo(A, table, row) {
  const v = (c) => row[c] != null ? String(row[c]) : null;
  const lic = String(A.lic);
  if (table === "licenses") return v("id") === lic;
  if (table === "users") return v("id") === String(A.uid) || v("license_key_id") === lic;
  if (table === "stations") return v("uuid") === A.uuid;
  for (const c of ["license_key_id", "license_id", "owner_license_id", "account_id"]) if (v(c) === lic) return true;
  if (v("station_uuid") === A.uuid) return true;
  if (v("license_key") === A.key) return true;
  if (v("user_id") === String(A.uid)) return true;
  if (v("machine_id") === A.machine || v("surface_id") === A.machine) return true;
  if (table === "backups" && (v("station_id") === A.uuid || v("station_id") === String(A.stationId))) return true;
  return false;
}

async function snapshot(pool) {
  const tables = (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map(r => r.table_name);
  const out = {};
  for (const t of tables) out[t] = (await pool.query(`SELECT * FROM "${t}"`)).rows;
  return out;
}

/** A's rows that differ between two snapshots: [{ table, kind: "added"|"removed", row }]. */
function aChanges(A, before, after) {
  const out = [];
  for (const t of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = (before[t] || []).filter(r => belongsTo(A, t, r)).map(r => JSON.stringify(r));
    const a = (after[t] || []).filter(r => belongsTo(A, t, r)).map(r => JSON.stringify(r));
    const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
    const cb = count(b), ca = count(a);
    for (const [x, n] of cb) if ((ca.get(x) || 0) < n) out.push({ table: t, kind: "removed", row: x });
    for (const [x, n] of ca) if ((cb.get(x) || 0) < n) out.push({ table: t, kind: "added", row: x });
  }
  return out;
}

/** One HTTP call that never hangs on a stream: reads at most ~1.5 s of body. */
async function callOnce(base, method, path, { headers = {}, body } = {}) {
  const h = { ...headers };
  let payload;
  if (body !== undefined && method !== "GET" && method !== "HEAD") { h["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1500);
  let status = 0, text = "";
  try {
    const res = await fetch(base + path, { method, headers: h, body: payload, redirect: "manual", signal: ac.signal });
    status = res.status;
    const reader = res.body && res.body.getReader();
    if (reader) {
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; text += Buffer.from(value).toString("utf8"); if (text.length > 200000) break; } }
      catch { /* aborted mid-stream: what arrived is what B saw */ }
      try { await reader.cancel(); } catch {}
    }
  } catch (e) { if (!status) status = -1; }
  finally { clearTimeout(timer); }
  return { status, text };
}

function fillPath(route, params) {
  return route.replace(/:([A-Za-z_]+)/g, (_, name) => encodeURIComponent(String(params[name] ?? `x-${name}`)));
}

/**
 * Aim every B credential at A's resource on `route` ("METHOD /path/:param"). Returns the violations found (empty = pass).
 * opts.params / opts.body override what A's ids are for this route.
 */
async function strangerAttempt(h, A, B, route, opts = {}) {
  const [method, path] = route.split(" ");
  const params = { ...paramsFor(A), ...(opts.params || {}) };
  const markers = markersOf(A);
  const violations = [];
  for (const cred of credentialsOf(B, h.secrets.JWT_SECRET)) {
    const qs = new URLSearchParams({ station_uuid: A.uuid, stationUuid: A.uuid, ...(cred.query || {}), ...(opts.query || {}) }).toString();
    const url = `${fillPath(path, params)}?${qs}`;
    const body = { ...bodyFor(A), ...(cred.body || {}), ...(opts.body || {}) };
    const before = await snapshot(h.pool);
    const r = await callOnce(h.base, method, url, { headers: cred.headers, body });
    const after = await snapshot(h.pool);
    const leaked = markers.filter(m => r.text.includes(m));
    if (leaked.length) violations.push({ route, cred: cred.name, status: r.status, kind: "leak", detail: leaked.join(", "), sample: r.text.slice(0, 200) });
    const changed = aChanges(A, before, after);
    if (changed.length) violations.push({ route, cred: cred.name, status: r.status, kind: "change", detail: changed.map(c => `${c.kind} ${c.table}`).join(", "), sample: changed[0].row.slice(0, 200) });
  }
  return violations;
}

module.exports = { seedAccount, tokensFor, credentialsOf, strangerAttempt, snapshot, aChanges, belongsTo, markersOf, callOnce };

/**
 * One area's stranger tests (node:test). Every account route of `area` in src/access/route-access.js gets a test; a
 * route with no entry here is still tested with A's default ids. `overrides[route]` = { params, body, query } for routes
 * whose ids live elsewhere. `controls` = [route, opts] that A's own credential must succeed on (proves the fixture
 * reaches the route's ownership check — a stranger test that every request fails for the wrong reason proves nothing).
 */
function runArea(area, { overrides = {}, controls = [] } = {}) {
  const test = require("node:test");
  const assert = require("node:assert");
  const { startServer } = require("../server-harness");
  const { ROUTES } = require("../../src/access/route-access");
  const routes = Object.entries(ROUTES).filter(([, v]) => v.access === "account" && v.area === area).map(([k]) => k);
  let h, A, B;
  test.before(async () => {
    h = await startServer();
    A = await seedAccount(h.pool, "A");
    B = await seedAccount(h.pool, "B");
  });
  test.after(async () => { if (h) await h.close(); });
  for (const [route, opts, check] of controls) {
    test(`control: A's own credential reaches ${route}`, async () => {
      const [method, path] = route.split(" ");
      const t = tokensFor(A, h.secrets.JWT_SECRET);
      const o = typeof opts === "function" ? opts(A, t) : opts;
      const url = path.replace(/:([A-Za-z_]+)/g, (_, n) => encodeURIComponent(String((o.params || {})[n] ?? ({ uuid: A.uuid, accountId: A.lic, id: A.lic, slug: A.slug, machineId: A.machine })[n])));
      const r = await callOnce(h.base, method, url + (o.query ? `?${new URLSearchParams(o.query)}` : ""), { headers: o.headers, body: o.body });
      assert.ok(r.status >= 200 && r.status < 300, `${route} as A: ${r.status} ${r.text.slice(0, 200)}`);
      if (check) check(r, A);
    });
  }
  test(`${area}: ${routes.length} account routes`, () => assert.ok(routes.length > 0));
  for (const route of routes) {
    test(`stranger: B cannot read or change A's data — ${route}`, async () => {
      const v = await strangerAttempt(h, A, B, route, overrides[route] || {});
      assert.deepEqual(v, [], `B reached A's data:\n${JSON.stringify(v, null, 2)}`);
    });
  }
}

module.exports.runArea = runArea;
