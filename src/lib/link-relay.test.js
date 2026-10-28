'use strict';
// Remote Link relay sessions: the backend introduces two machines of ONE account and signs their relay ticket.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const { newDb } = require("pg-mem");
const LR = require("./link-relay");
const { verifyTicket } = require("../../relay/ticket");

const SECRET = "s".repeat(40), ST = "11111111-2222-3333-4444-555555555555";

async function harness() {
  const db = newDb();
  db.public.none(`
    CREATE TABLE users (id INT PRIMARY KEY, email TEXT, license_key_id INT);
    CREATE TABLE licenses (id INT PRIMARY KEY, email TEXT, license_key TEXT, plan TEXT, active BOOLEAN DEFAULT true);
    CREATE TABLE license_activations (id SERIAL PRIMARY KEY, license_key TEXT NOT NULL, machine_id TEXT NOT NULL, machine_name TEXT,
      os TEXT, last_seen TIMESTAMPTZ DEFAULT NOW(), deauthorized_at TIMESTAMPTZ);
    INSERT INTO licenses VALUES (10, 'a@example.org', 'ETH-A', 'station', true), (20, 'b@example.org', 'ETH-B', 'station', true);
    INSERT INTO users VALUES (1, 'a@example.org', 10), (2, 'b@example.org', 20);
    INSERT INTO license_activations (license_key, machine_id, machine_name) VALUES ('ETH-A', 'm-venue', 'VenueLaptop'), ('ETH-A', 'm-ov', 'ovowforestmusic'),
      ('ETH-B', 'm-b', 'OtherStation'), ('ETH-B', 'm-ov', 'copied id');`);
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  for (const ddl of LR.LINK_RELAY_DDL) await pool.query(ddl);
  const users = { 1: { uid: 1, typ: "user" }, 2: { uid: 2, typ: "user" } };
  const requireUser = (req, res, next) => { const u = users[req.headers["x-uid"]]; if (!u) return res.status(401).json({ error: "missing_token" }); req.user = u; next(); };
  const app = express();
  app.use("/api/link/relay", LR.router(pool, requireUser, { secret: SECRET, host: "relay.example", port: 9790 }));
  const server = http.createServer(app); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api/link/relay`;
  const call = async (uid, method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-uid": String(uid) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { call, close: () => new Promise(r => server.close(r)) };
}

test("the sender gets a signed ticket for two machines of its account; the receiver's poll sees it with the sender's name", async () => {
  const h = await harness();
  try {
    const s = await h.call(1, "POST", "/session", { sender_machine: "m-venue", receiver_machine: "m-ov", station_uuid: ST });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual([s.body.relay_host, s.body.relay_port], ["relay.example", 9790]);
    const t = verifyTicket(SECRET, s.body.ticket);
    assert.deepEqual([t.session, t.sender, t.receiver], [s.body.tag, "m-venue", "m-ov"]);
    const again = await h.call(1, "POST", "/session", { sender_machine: "m-venue", receiver_machine: "m-ov", station_uuid: ST });
    assert.equal(again.body.tag, s.body.tag, "the same pair and station get the same session, renewed");
    const poll = await h.call(1, "GET", "/sessions?machine=m-ov");
    assert.deepEqual(poll.body.sessions.map(x => [x.tag, x.sender_name, x.station_uuid]), [[s.body.tag, "VenueLaptop", ST]]);
    assert.ok(verifyTicket(SECRET, poll.body.sessions[0].ticket));
  } finally { await h.close(); }
});

test("STRANGER: another account cannot open a session to your machine, nor see your sessions — even with the same machine id", async () => {
  const h = await harness();
  try {
    await h.call(1, "POST", "/session", { sender_machine: "m-venue", receiver_machine: "m-ov", station_uuid: ST });
    assert.equal((await h.call(2, "POST", "/session", { sender_machine: "m-b", receiver_machine: "m-venue", station_uuid: ST })).status, 403);
    // m-ov is ALSO seated on account B (a copied id): B's poll must not see A's session to it
    assert.deepEqual((await h.call(2, "GET", "/sessions?machine=m-ov")).body.sessions, []);
    // and B cannot join two machines across accounts (m-b is B's, m-venue is A's)
    assert.equal((await h.call(2, "POST", "/session", { sender_machine: "m-b", receiver_machine: "m-ov", station_uuid: ST })).status, 200,
      "B may feed its OWN seat of m-ov (license 20)…");
    assert.equal((await h.call(1, "GET", "/sessions?machine=m-ov")).body.sessions.length, 1, "…which A never sees");
  } finally { await h.close(); }
});

test("refusals: a machine feeding itself, bad ids, no sign-in", async () => {
  const h = await harness();
  try {
    assert.equal((await h.call(1, "POST", "/session", { sender_machine: "m-ov", receiver_machine: "m-ov", station_uuid: ST })).status, 400);
    assert.equal((await h.call(1, "POST", "/session", { sender_machine: "x y", receiver_machine: "m-ov", station_uuid: ST })).status, 400);
    assert.equal((await h.call(1, "POST", "/session", { sender_machine: "m-venue", receiver_machine: "m-ov", station_uuid: "nope" })).status, 400);
    assert.equal((await h.call(9, "GET", "/sessions?machine=m-ov")).status, 401);
  } finally { await h.close(); }
});

test("without a relay secret and host configured, it says so (503) and signs nothing", async () => {
  const app = express();
  app.use("/r", LR.router(null, (q, s, n) => { q.user = { uid: 1 }; n(); }, { secret: "", host: "" }));
  const server = http.createServer(app); await new Promise(r => server.listen(0, r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/r/sessions?machine=m-ov`);
    assert.equal(r.status, 503);
  } finally { await new Promise(r => server.close(r)); }
});
