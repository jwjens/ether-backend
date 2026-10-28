'use strict';
// Sign-in sessions (Jeff, 2026-10-28): a running station stays signed in forever — a short pass renewed silently, no
// limit while the computer runs; ends only on Sign Out, a password change, or the computer removed, within minutes; the
// offline limit is a user setting (90 days, or never). Real router, real SQL on pg-mem, a real HTTP server.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");
const { newDb } = require("pg-mem");
const AS = require("./auth-sessions");

const SECRET = "test-secret";
const DAY = 86400000;

async function harness() {
  const db = newDb();
  db.public.none(`
    CREATE TABLE users (id INT PRIMARY KEY, email TEXT);
    INSERT INTO users (id, email) VALUES (1, 'jeff@example.org'), (2, 'other@example.org');`);
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  for (const ddl of AS.AUTH_SESSIONS_DDL) await pool.query(ddl);
  let nowMs = Date.parse("2026-10-28T12:00:00Z");
  const S = AS.create({ pool, jwt, secret: SECRET, now: () => nowMs });
  const requireUser = async (req, res, next) => {
    const h = req.headers.authorization || "";
    try {
      const p = jwt.verify(h.slice(7), SECRET, { clockTimestamp: Math.floor(nowMs / 1000) });
      if (!(await S.guard(p))) return res.status(401).json({ error: "session_ended" });
      req.user = p; next();
    } catch { res.status(401).json({ error: "invalid_token" }); }
  };
  const app = express();
  app.use("/api/auth", S.router(requireUser, { rateLimit: false }));
  app.get("/api/me", requireUser, (req, res) => res.json({ uid: req.user.uid }));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body } = {}) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
                                         body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const user = async (id) => (await pool.query(`SELECT * FROM users WHERE id = $1`, [id])).rows[0];
  return { S, pool, call, user, advance: (ms) => { nowMs += ms; }, close: () => new Promise(r => server.close(r)) };
}

test("a pass is 15 minutes by default and carries its session", async () => {
  const h = await harness();
  try {
    const s = await h.S.start(await h.user(1), { machineId: "m-ov", deviceName: "ovowforestmusic" });
    const p = jwt.decode(s.access_token);
    assert.equal(p.sid, s.session_id); assert.equal(p.exp - p.iat, 15 * 60); assert.equal(s.access_expires_in, 900);
    assert.equal((await h.call("GET", "/api/me", { token: s.access_token })).status, 200);
  } finally { await h.close(); }
});

test("a running station stays signed in forever: renewing every 15 minutes never runs out (a year of renewals)", async () => {
  const h = await harness();
  try {
    let s = await h.S.start(await h.user(1), { machineId: "m-ov" });
    for (let i = 0; i < 365 * 4; i++) {          // a renewal every 6 h for a year (each renewal also rotates the token)
      h.advance(6 * 3600 * 1000);
      const r = await h.call("POST", "/api/auth/refresh", { body: { refresh_token: s.refresh_token } });
      assert.equal(r.status, 200, `renewal ${i}: ${JSON.stringify(r.body)}`);
      s = r.body;
    }
    assert.equal((await h.call("GET", "/api/me", { token: s.access_token })).status, 200);
  } finally { await h.close(); }
});

test("renewal rotates: the old refresh token stops working, and presenting it again ends the session (theft signal)", async () => {
  const h = await harness();
  try {
    const s1 = await h.S.start(await h.user(1), { machineId: "m-ov" });
    const s2 = (await h.call("POST", "/api/auth/refresh", { body: { refresh_token: s1.refresh_token } })).body;
    assert.notEqual(s2.refresh_token, s1.refresh_token);
    const reuse = await h.call("POST", "/api/auth/refresh", { body: { refresh_token: s1.refresh_token } });
    assert.equal(reuse.status, 401); assert.equal(reuse.body.reason, "refresh_reused");
    assert.equal((await h.call("POST", "/api/auth/refresh", { body: { refresh_token: s2.refresh_token } })).status, 401, "the whole session ended");
  } finally { await h.close(); }
});

test("a password change ends every session, and its passes are refused within the cache window", async () => {
  const h = await harness();
  try {
    const a = await h.S.start(await h.user(1), { machineId: "m-ov" });
    const b = await h.S.start(await h.user(1), { machineId: "m-events" });
    assert.equal((await h.call("GET", "/api/me", { token: a.access_token })).status, 200);
    assert.equal(await h.S.revokeUser(1, "password_changed"), 2);
    assert.equal((await h.call("GET", "/api/me", { token: a.access_token })).status, 401, "an already-issued pass is refused");
    const r = await h.call("POST", "/api/auth/refresh", { body: { refresh_token: b.refresh_token } });
    assert.deepEqual([r.status, r.body.reason], [401, "password_changed"]);
  } finally { await h.close(); }
});

test("the computer removed from the account: its sessions end; other computers keep theirs", async () => {
  const h = await harness();
  try {
    const ov = await h.S.start(await h.user(1), { machineId: "m-ov" });
    const ev = await h.S.start(await h.user(1), { machineId: "m-events" });
    assert.equal(await h.S.revokeMachine("m-ov", [1]), 1);
    assert.equal((await h.call("POST", "/api/auth/refresh", { body: { refresh_token: ov.refresh_token } })).body.reason, "computer_removed");
    assert.equal((await h.call("POST", "/api/auth/refresh", { body: { refresh_token: ev.refresh_token } })).status, 200);
  } finally { await h.close(); }
});

test("Sign Out ends this computer's session (by its refresh token, even with an expired pass); Sign out everywhere ends all", async () => {
  const h = await harness();
  try {
    const a = await h.S.start(await h.user(1), { machineId: "m-ov" });
    const b = await h.S.start(await h.user(1), { machineId: "m-events" });
    h.advance(20 * 60 * 1000);   // the pass has expired
    assert.equal((await h.call("POST", "/api/auth/logout", { body: { refresh_token: a.refresh_token } })).status, 200);
    assert.equal((await h.call("POST", "/api/auth/refresh", { body: { refresh_token: a.refresh_token } })).body.reason, "sign_out");
    const b2 = (await h.call("POST", "/api/auth/refresh", { body: { refresh_token: b.refresh_token } })).body;
    assert.equal((await h.call("POST", "/api/auth/logout-all", { token: b2.access_token })).body.ended, 1);
    assert.equal((await h.call("POST", "/api/auth/refresh", { body: { refresh_token: b2.refresh_token } })).status, 401);
  } finally { await h.close(); }
});

test("offline limit: 90 days without a check-in ends it; 'never' never does; both are the user's setting", async () => {
  const h = await harness();
  try {
    const s = await h.S.start(await h.user(1), { machineId: "m-ov" });
    h.advance(91 * DAY);
    assert.equal((await h.call("POST", "/api/auth/refresh", { body: { refresh_token: s.refresh_token } })).body.reason, "offline_limit");

    const s2 = await h.S.start(await h.user(1), { machineId: "m-ov" });
    const set = await h.call("PUT", "/api/auth/settings", { token: s2.access_token, body: { offline_days: "never", access_minutes: 30 } });
    assert.deepEqual(set.body, { accessMinutes: 30, offlineDays: null });
    h.advance(3 * 365 * DAY);
    const r = await h.call("POST", "/api/auth/refresh", { body: { refresh_token: s2.refresh_token } });
    assert.equal(r.status, 200, "three years offline, 'never': still signed in");
    const p = jwt.decode(r.body.access_token);
    assert.equal(p.exp - p.iat, 30 * 60, "the pass length follows the user's setting");
    assert.equal((await h.call("PUT", "/api/auth/settings", { token: r.body.access_token, body: { access_minutes: 1 } })).status, 400);
  } finally { await h.close(); }
});

test("STRANGER: another user cannot list or end someone else's sessions", async () => {
  const h = await harness();
  try {
    const mine = await h.S.start(await h.user(1), { machineId: "m-ov" });
    const theirs = await h.S.start(await h.user(2), { machineId: "m-x" });
    const list = await h.call("GET", "/api/auth/sessions", { token: theirs.access_token });
    assert.deepEqual(list.body.sessions.map(s => s.id), [theirs.session_id]);
    assert.equal((await h.call("DELETE", `/api/auth/sessions/${mine.session_id}`, { token: theirs.access_token })).status, 404);
    assert.equal((await h.call("POST", "/api/auth/refresh", { body: { refresh_token: mine.refresh_token } })).status, 200, "untouched");
  } finally { await h.close(); }
});

test("an old pass without a session id keeps working until its own expiry (no forced sign-out on deploy)", async () => {
  const h = await harness();
  try {
    const old = jwt.sign({ uid: 1, email: "jeff@example.org", typ: "user" }, SECRET, { expiresIn: "12h" });
    assert.equal((await h.call("GET", "/api/me", { token: old })).status, 200);
  } finally { await h.close(); }
});

test("upgrade: an old 12 h pass is swapped once for a renewable session; a session pass cannot upgrade", async () => {
  const h = await harness();
  try {
    const old = jwt.sign({ uid: 1, email: "jeff@example.org", typ: "user" }, SECRET, { expiresIn: "12h" });
    const r = await h.call("POST", "/api/auth/upgrade", { token: old, body: { machine_id: "m-ov", machine_name: "ovowforestmusic" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.refresh_token && r.body.access_token);
    assert.equal((await h.call("POST", "/api/auth/refresh", { body: { refresh_token: r.body.refresh_token } })).status, 200);
    assert.equal((await h.call("POST", "/api/auth/upgrade", { token: r.body.access_token, body: {} })).status, 400);
  } finally { await h.close(); }
});
