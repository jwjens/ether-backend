'use strict';
// Remote Link pairing (Jeff's ruling, 2026-10-04): the link key is never copied or typed by hand.
//   · SAME ACCOUNT (default): a machine publishes its key; any machine on the same account lists the account's
//     machines and fetches the one it picks.
//   · GUEST (different account): the sender shows an 8-character code, XXXX-XXXX, valid 10 minutes, ONE use; the
//     receiver types it; the backend hands the key over once and forgets the code.
// Real router, real SQL, in-memory Postgres (pg-mem), a real HTTP server on an ephemeral port.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const { newDb } = require("pg-mem");
const LP = require("./link-pairing");

const KEY_A = "a".repeat(64), KEY_A2 = "b".repeat(64), KEY_G = "c".repeat(64);

async function harness(extraSql = "", afterDdl = "") {
  const db = newDb();
  db.public.none(`
    CREATE TABLE users (id INT PRIMARY KEY, email TEXT, license_key_id INT);
    CREATE TABLE licenses (id INT PRIMARY KEY, email TEXT, license_key TEXT, plan TEXT, active BOOLEAN DEFAULT true);
    CREATE TABLE license_activations (id SERIAL PRIMARY KEY, license_key TEXT NOT NULL, machine_id TEXT NOT NULL, machine_name TEXT,
      os TEXT, last_seen TIMESTAMPTZ DEFAULT NOW(), deauthorized_at TIMESTAMPTZ);
    -- account 1 (Jeff): two machines on one license; account 2 (a guest): one machine
    INSERT INTO licenses VALUES (10, 'jeff@example.org', 'ETH-STN-AAAA', 'station', true);
    INSERT INTO licenses VALUES (20, 'guest@example.org', NULL, 'station', true);
    INSERT INTO users VALUES (1, 'jeff@example.org', 10);
    INSERT INTO users VALUES (2, 'guest@example.org', 20);
    INSERT INTO license_activations (license_key, machine_id, machine_name) VALUES ('ETH-STN-AAAA', 'm-ov', 'ovowforestmusic');
    INSERT INTO license_activations (license_key, machine_id, machine_name) VALUES ('ETH-STN-AAAA', 'm-events', 'OVEVENTS');
    INSERT INTO license_activations (license_key, machine_id, machine_name, deauthorized_at) VALUES ('ETH-STN-AAAA', 'm-old', 'retired', NOW());
    INSERT INTO license_activations (license_key, machine_id, machine_name) VALUES ('lic-20', 'm-guest', 'GuestVan');
  ` + extraSql);
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  for (const ddl of LP.LINK_PAIRING_DDL) await pool.query(ddl);
  if (afterDdl) db.public.none(afterDdl);
  let nowMs = Date.parse("2026-10-04T23:00:00Z");
  const users = { 1: { uid: 1, email: "jeff@example.org", typ: "user" }, 2: { uid: 2, email: "guest@example.org", typ: "user" },
                  3: { uid: 3, email: "jeff@example.org", typ: "user" }, 4: { uid: 4, email: "pd@example.org", typ: "user" } };
  const requireUser = (req, res, next) => {
    const u = users[req.headers["x-test-uid"]];
    if (!u) return res.status(401).json({ error: "missing_token" });
    req.user = u; next();
  };
  const app = express();
  app.use(express.json());
  app.use("/api/link", LP.router(pool, requireUser, { now: () => new Date(nowMs), rateLimit: false }));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api/link`;
  const call = async (uid, method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-test-uid": String(uid) },
                                         body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { call, advance: (ms) => { nowMs += ms; }, close: () => new Promise(r => server.close(r)) };
}

test("codes: 8 characters from an alphabet with no look-alikes, shown XXXX-XXXX", () => {
  for (let i = 0; i < 200; i++) {
    const c = LP.makeCode();
    assert.match(c, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    assert.match(LP.formatCode(c), /^[23456789A-Z]{4}-[23456789A-Z]{4}$/);
  }
  assert.ok(!/[01OIL]/.test(LP.CODE_ALPHABET), "no 0/O, 1/I/L");
});

test("codes: typed loosely is accepted; anything else is refused", () => {
  assert.equal(LP.normalizeCode("k7qd-2xmf"), "K7QD2XMF");
  assert.equal(LP.normalizeCode("  K7QD 2XMF "), "K7QD2XMF");
  assert.equal(LP.normalizeCode("K7QD2XM"), null, "7 characters");
  assert.equal(LP.normalizeCode("K7QD-2XM0"), null, "0 is not in the alphabet");
  assert.equal(LP.normalizeCode(""), null);
});

test("same account: a published key is listed and fetched by the account's other machine", async () => {
  const h = await harness();
  try {
    let r = await h.call(1, "PUT", "/key", { machine_id: "m-ov", machine_name: "ovowforestmusic", key: KEY_A, key_id: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.fingerprint, LP.fingerprint(KEY_A));
    r = await h.call(1, "GET", "/machines");
    assert.equal(r.status, 200);
    const ids = r.body.machines.map(m => m.machine_id).sort();
    assert.deepEqual(ids, ["m-events", "m-ov"], "active seats only — the deauthorized machine is not offered");
    const ov = r.body.machines.find(m => m.machine_id === "m-ov");
    assert.equal(ov.published, true); assert.equal(ov.fingerprint, LP.fingerprint(KEY_A)); assert.equal(ov.key_id, 2);
    assert.equal(ov.key, undefined, "the list never carries keys");
    assert.equal(r.body.machines.find(m => m.machine_id === "m-events").published, false);
    r = await h.call(1, "GET", "/key/m-ov");
    assert.equal(r.status, 200);
    assert.deepEqual({ key: r.body.key, key_id: r.body.key_id, machine_name: r.body.machine_name }, { key: KEY_A, key_id: 2, machine_name: "ovowforestmusic" });
    // Replace key: the re-published key is what the next fetch returns.
    await h.call(1, "PUT", "/key", { machine_id: "m-ov", machine_name: "ovowforestmusic", key: KEY_A2, key_id: 3 });
    r = await h.call(1, "GET", "/key/m-ov");
    assert.equal(r.body.key, KEY_A2); assert.equal(r.body.key_id, 3);
  } finally { await h.close(); }
});

test("another account can neither fetch nor publish for a machine that is not theirs", async () => {
  const h = await harness();
  try {
    await h.call(1, "PUT", "/key", { machine_id: "m-ov", machine_name: "ovowforestmusic", key: KEY_A, key_id: 2 });
    let r = await h.call(2, "GET", "/key/m-ov");
    assert.equal(r.status, 404, "not in your account — indistinguishable from 'no such machine'");
    assert.equal(r.body.key, undefined);
    r = await h.call(2, "PUT", "/key", { machine_id: "m-ov", machine_name: "x", key: KEY_G, key_id: 9 });
    assert.equal(r.status, 403);
    r = await h.call(1, "GET", "/key/m-ov");
    assert.equal(r.body.key, KEY_A, "the guest's attempt changed nothing");
    r = await h.call(2, "GET", "/machines");
    assert.deepEqual(r.body.machines.map(m => m.machine_id), ["m-guest"]);
    r = await h.call(1, "PUT", "/key", { machine_id: "m-ov", machine_name: "ovowforestmusic", key: "zz", key_id: 2 });
    assert.equal(r.status, 400, "a key is 64 hex");
  } finally { await h.close(); }
});

test("guest pairing: an 8-character code hands the key over ONCE, then is gone", async () => {
  const h = await harness();
  try {
    let r = await h.call(1, "POST", "/pair-code", { machine_id: "m-ov", machine_name: "ovowforestmusic", key: KEY_A, key_id: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.code, /^[23456789A-Z]{4}-[23456789A-Z]{4}$/);
    assert.equal(Date.parse(r.body.expires_at) - Date.parse("2026-10-04T23:00:00Z"), 10 * 60 * 1000, "valid 10 minutes");
    const code = r.body.code;
    r = await h.call(2, "POST", "/pair-redeem", { code: code.toLowerCase() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual({ machine_id: r.body.machine_id, machine_name: r.body.machine_name, key: r.body.key, key_id: r.body.key_id },
                     { machine_id: "m-ov", machine_name: "ovowforestmusic", key: KEY_A, key_id: 2 });
    r = await h.call(2, "POST", "/pair-redeem", { code });
    assert.equal(r.status, 404, "one use");
  } finally { await h.close(); }
});

test("guest pairing: a code is dead after 10 minutes, and a new code replaces the old one", async () => {
  const h = await harness();
  try {
    const first = (await h.call(1, "POST", "/pair-code", { machine_id: "m-ov", machine_name: "ovowforestmusic", key: KEY_A, key_id: 2 })).body.code;
    const second = (await h.call(1, "POST", "/pair-code", { machine_id: "m-ov", machine_name: "ovowforestmusic", key: KEY_A, key_id: 2 })).body.code;
    let r = await h.call(2, "POST", "/pair-redeem", { code: first });
    assert.equal(r.status, 404, "the earlier code for this machine was replaced");
    h.advance(10 * 60 * 1000 + 1);
    r = await h.call(2, "POST", "/pair-redeem", { code: second });
    assert.equal(r.status, 404, "expired");
    r = await h.call(2, "POST", "/pair-redeem", { code: "not a code" });
    assert.equal(r.status, 400);
    r = await h.call(2, "POST", "/pair-code", { machine_id: "m-ov", machine_name: "x", key: KEY_G, key_id: 1 });
    assert.equal(r.status, 403, "a code is made only for a machine in your own account");
  } finally { await h.close(); }
});

test("fingerprint matches the desktop's (audiod/link.js keyFingerprint): sha256 → 8 hex, XXXX-XXXX", () => {
  const crypto = require("node:crypto");
  const want = crypto.createHash("sha256").update(KEY_A).digest("hex").slice(0, 8).toUpperCase().replace(/(.{4})/, "$1-");
  assert.equal(LP.fingerprint(KEY_A), want);
});

// ── THE "SAME ACCOUNT" GAP (docs/multitenancy-audit.md H5 and M1), closed 2026-10-28 ───────────────────────────────────
const STRANGER = `INSERT INTO users VALUES (3, 'jeff@example.org', NULL);`;   // signed up with Jeff's purchase email, unverified

test("H5: a stranger who signed up with a customer's email gets nothing: no machines, no key, no replacing it", async () => {
  const h = await harness(STRANGER);
  try {
    await h.call(1, "PUT", "/key", { machine_id: "m-ov", machine_name: "ovowforestmusic", key: KEY_A, key_id: 2 });
    let r = await h.call(3, "GET", "/machines");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.machines, [], "the email match is not the account");
    r = await h.call(3, "GET", "/key/m-ov");
    assert.equal(r.status, 404); assert.equal(r.body.key, undefined);
    r = await h.call(3, "PUT", "/key", { machine_id: "m-ov", machine_name: "x", key: KEY_G, key_id: 9 });
    assert.equal(r.status, 403);
    r = await h.call(3, "POST", "/pair-code", { machine_id: "m-ov", machine_name: "x", key: KEY_G, key_id: 9 });
    assert.equal(r.status, 403);
    r = await h.call(1, "GET", "/key/m-ov");
    assert.equal(r.body.key, KEY_A, "the customer's key is untouched");
  } finally { await h.close(); }
});

test("an account member (memberships) is in the account; a removed member is not", async () => {
  const h = await harness(`
    INSERT INTO users VALUES (4, 'pd@example.org', NULL);
    CREATE TABLE memberships (id SERIAL PRIMARY KEY, user_id INT, account_id INT, status TEXT DEFAULT 'active', deleted_at TIMESTAMPTZ);
    INSERT INTO memberships (user_id, account_id) VALUES (4, 10);`);
  try {
    await h.call(1, "PUT", "/key", { machine_id: "m-ov", machine_name: "ovowforestmusic", key: KEY_A, key_id: 2 });
    let r = await h.call(4, "GET", "/machines");
    assert.deepEqual(r.body.machines.map(m => m.machine_id).sort(), ["m-events", "m-ov"]);
    r = await h.call(4, "GET", "/key/m-ov");
    assert.equal(r.body.key, KEY_A);
  } finally { await h.close(); }
  const h2 = await harness(`
    INSERT INTO users VALUES (4, 'pd@example.org', NULL);
    CREATE TABLE memberships (id SERIAL PRIMARY KEY, user_id INT, account_id INT, status TEXT DEFAULT 'active', deleted_at TIMESTAMPTZ);
    INSERT INTO memberships (user_id, account_id, deleted_at) VALUES (4, 10, NOW());`);
  try {
    const r = await h2.call(4, "GET", "/key/m-ov");
    assert.equal(r.status, 404, "a removed member has no account");
  } finally { await h2.close(); }
});

test("M1: one machine id seated on two accounts — each account's key is its own; neither reads or replaces the other's", async () => {
  const h = await harness(`
    INSERT INTO license_activations (license_key, machine_id, machine_name) VALUES ('ETH-STN-AAAA', 'm-shared', 'StudioPC');
    INSERT INTO license_activations (license_key, machine_id, machine_name) VALUES ('lic-20', 'm-shared', 'copied id');`);
  try {
    let r = await h.call(1, "PUT", "/key", { machine_id: "m-shared", machine_name: "StudioPC", key: KEY_A, key_id: 2 });
    assert.equal(r.status, 200);
    r = await h.call(2, "GET", "/key/m-shared");
    assert.equal(r.status, 404, "the guest's account has no key for its seat with that id");
    r = await h.call(2, "GET", "/machines");
    assert.equal(r.body.machines.find(m => m.machine_id === "m-shared").published, false);
    r = await h.call(2, "PUT", "/key", { machine_id: "m-shared", machine_name: "copied id", key: KEY_G, key_id: 7 });
    assert.equal(r.status, 200, "it may publish its OWN key for its own seat");
    r = await h.call(1, "GET", "/key/m-shared");
    assert.equal(r.body.key, KEY_A, "…which never replaces the first account's key");
    r = await h.call(2, "GET", "/key/m-shared");
    assert.equal(r.body.key, KEY_G);
  } finally { await h.close(); }
});

test("a key in the old link_keys table (keyed by machine id alone) is never served", async () => {
  const h = await harness("", `
    INSERT INTO link_keys (machine_id, machine_name, key_hex, key_id, fingerprint, published_by) VALUES ('m-ov', 'ovowforestmusic', '${KEY_G}', 5, 'XXXX-XXXX', 3);`);
  try {
    let r = await h.call(1, "GET", "/key/m-ov");
    assert.equal(r.status, 404, "until the machine re-publishes (at start and hourly)");
    await h.call(1, "PUT", "/key", { machine_id: "m-ov", machine_name: "ovowforestmusic", key: KEY_A, key_id: 2 });
    r = await h.call(1, "GET", "/key/m-ov");
    assert.equal(r.body.key, KEY_A);
  } finally { await h.close(); }
});
