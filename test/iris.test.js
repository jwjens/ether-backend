'use strict';
// Iris Stage 1 routes (src/routes/iris.js). In-memory Postgres (pg-mem) and a recording fake of the Anthropic client:
// nothing leaves the machine. Desktop repo: docs/iris-stage1-plan-2026-11-04.md.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const { newDb } = require("pg-mem");
const iris = require("../src/routes/iris");

const LICENSES = {
  "lk-local": { id: 1, plan: "local" },
  "lk-live": { id: 2, plan: "station" },
  "lk-life": { id: 3, plan: "unlimited_lifetime" },
  "lk-free": { id: 4, plan: "free" },
};
const PACK = {
  v: 1, version: "4.6.71", builtAt: "2026-11-04T00:00:00Z",
  sections: [
    { id: "manual-ch04-the-broadcast-delay-delay-and-dump", chapter: 4, chapterTitle: "Running the show", title: "The broadcast delay: DELAY and DUMP", text: "Press **DELAY**, then **DUMP**." },
    { id: "manual-ch14-loudness", chapter: 14, chapterTitle: "Streaming", title: "Loudness", text: "The Loudness target is in File → Settings → Audio." },
    { id: "manual-ch01-signing-out", chapter: 1, chapterTitle: "Getting started", title: "7. Signing out", text: "SECRET-UNSENT-SECTION" },
  ],
};

async function start({ withAi = true, usage } = {}) {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const calls = [];
  const anthropic = withAi ? { messages: { create: async (req) => {
    calls.push(req);
    return { stop_reason: "end_turn", usage: usage || { input_tokens: 1200, output_tokens: 600, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
      content: [{ type: "text", text: JSON.stringify({ answer: "Press DELAY, then DUMP.", yours: ["Your delay is off."], chapters: ["manual-ch04-the-broadcast-delay-delay-and-dump", "made-up-id"], covered: true }) }] };
  } } } : null;
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/iris", iris(pool, async (k) => LICENSES[k] || null, { anthropic, adminSecret: () => "admin-test" }));
  const srv = await new Promise(r => { const s = http.createServer(app).listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/iris`;
  const call = async (method, path, { body, key, headers = {} } = {}) => {
    const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(key ? { "x-license-key": key } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
  };
  return { call, calls, pool, close: () => new Promise(r => srv.close(r)) };
}

test("knowledge: only the admin secret publishes; anyone reads; an older version gets the nearest earlier pack", async () => {
  const s = await start();
  try {
    assert.equal((await s.call("POST", "/knowledge", { body: PACK })).status, 403);
    assert.equal((await s.call("POST", "/knowledge", { body: PACK, headers: { "x-admin-secret": "admin-test" } })).body.sections, 3);
    const r = await s.call("GET", "/knowledge?version=4.6.80");
    assert.equal(r.status, 200);
    assert.equal(r.body.version, "4.6.71");
    const again = await s.call("GET", "/knowledge?version=4.6.71", { headers: { "if-none-match": r.headers.get("etag") } });
    assert.equal(again.status, 304);
  } finally { await s.close(); }
});

test("ask: needs a license key; sends only the matching sections + the settings, never the rest of the manual", async () => {
  const s = await start();
  try {
    await s.call("POST", "/knowledge", { body: PACK, headers: { "x-admin-secret": "admin-test" } });
    assert.equal((await s.call("POST", "/ask", { body: { question: "dump?" } })).status, 401);
    assert.equal((await s.call("POST", "/ask", { key: "lk-nope", body: { question: "dump?" } })).status, 401);
    const r = await s.call("POST", "/ask", { key: "lk-live", body: {
      version: "4.6.71", question: "How do I dump a caller?",
      sectionIds: ["manual-ch04-the-broadcast-delay-delay-and-dump", "not-in-pack"],
      settings: [{ label: "Broadcast delay", value: "off", where: "the DELAY button in the bottom bar" }],
    } });
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, "ai");
    assert.equal(r.body.answer, "Press DELAY, then DUMP.");
    assert.deepEqual(r.body.yours, ["Your delay is off."]);
    assert.deepEqual(r.body.chapters, ["manual-ch04-the-broadcast-delay-delay-and-dump"]);   // a made-up id is dropped
    assert.equal(s.calls.length, 1);
    const req = s.calls[0];
    assert.equal(req.model, "claude-haiku-5-5");
    assert.equal(req.output_config.effort, "low");
    assert.equal(req.system[0].cache_control.type, "ephemeral");
    const sent = req.messages.at(-1).content;
    assert.match(sent, /Press \*\*DELAY\*\*/);
    assert.match(sent, /Broadcast delay: off \(change it in the DELAY button/);
    assert.doesNotMatch(sent, /SECRET-UNSENT-SECTION/);
    assert.doesNotMatch(sent, /The Loudness target/);
  } finally { await s.close(); }
});

test("fair use: 300 AI questions a month or the $3 meter → mode 'limit', no AI call", async () => {
  const s = await start();
  try {
    await s.call("POST", "/knowledge", { body: PACK, headers: { "x-admin-secret": "admin-test" } });
    await s.call("GET", "/capability", { key: "lk-live" });   // creates the tables
    const month = new Date().toISOString().slice(0, 7);
    await s.pool.query(`INSERT INTO iris_usage (license_id, month, ai_questions, cost_micros) VALUES (2, $1, 300, 10)`, [month]);
    await s.pool.query(`INSERT INTO iris_usage (license_id, month, ai_questions, cost_micros) VALUES (3, $1, 5, 3000000)`, [month]);
    const a = await s.call("POST", "/ask", { key: "lk-live", body: { version: "4.6.71", question: "x?", sectionIds: [] } });
    const b = await s.call("POST", "/ask", { key: "lk-life", body: { version: "4.6.71", question: "x?", sectionIds: [] } });
    assert.equal(a.body.mode, "limit");
    assert.equal(b.body.mode, "limit");
    assert.equal(s.calls.length, 0);
  } finally { await s.close(); }
});

test("the meter counts what was really spent (Haiku 5.5 list prices)", async () => {
  // 1200 in × $0.10/M + 900 cache-read × $0.01/M + 600 out × $0.50/M = 120 + 9 + 300 = 429 µ$
  assert.equal(iris.costMicros({ input_tokens: 1200, output_tokens: 600, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 }), 429);
  // over 100K prompt tokens → the higher row ($0.50/M in)
  assert.equal(iris.costMicros({ input_tokens: 100_001, output_tokens: 0 }), Math.ceil(100_001 * 0.5));
  const s = await start();
  try {
    await s.call("POST", "/knowledge", { body: PACK, headers: { "x-admin-secret": "admin-test" } });
    await s.call("POST", "/ask", { key: "lk-live", body: { version: "4.6.71", question: "dump?", sectionIds: [] } });
    const { rows } = await s.pool.query(`SELECT ai_questions, cost_micros FROM iris_usage WHERE license_id = 2`);
    assert.equal(Number(rows[0].ai_questions), 1);
    assert.equal(Number(rows[0].cost_micros), 429);
  } finally { await s.close(); }
});

test("capability: Local speaks answers; every other plan (Live, Lifetime, Free old key) is the top tier; voice not built yet", async () => {
  const s = await start();
  try {
    const local = (await s.call("GET", "/capability", { key: "lk-local" })).body;
    const live = (await s.call("GET", "/capability", { key: "lk-live" })).body;
    const life = (await s.call("GET", "/capability", { key: "lk-life" })).body;
    const free = (await s.call("GET", "/capability", { key: "lk-free" })).body;
    assert.equal(local.tier, "local");
    assert.equal(local.allowance.spoken, 110);
    for (const c of [live, life, free]) { assert.equal(c.tier, "top"); assert.equal(c.allowance.spoken, 100); }
    for (const c of [local, live, life, free]) { assert.equal(c.voiceBuilt, false); assert.equal(c.speakAnswers, false); assert.equal(c.speakQuestions, false); assert.equal(c.allowance.aiQuestions, 300); }
    assert.equal((await s.call("POST", "/speak", { key: "lk-live", body: {} })).status, 501);
  } finally { await s.close(); }
});

test("no AI key configured → 503, so the desktop answers from the manual", async () => {
  const s = await start({ withAi: false });
  try {
    await s.call("POST", "/knowledge", { body: PACK, headers: { "x-admin-secret": "admin-test" } });
    assert.equal((await s.call("POST", "/ask", { key: "lk-live", body: { version: "4.6.71", question: "x?" } })).status, 503);
  } finally { await s.close(); }
});
