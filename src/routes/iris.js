'use strict';
// IRIS STAGE 1 — Ether's built-in help (Jeff, 2026-11-04; desktop repo docs/iris-stage1-plan-2026-11-04.md and the
// contract's help-mode section, docs/iris-ether-contract.md §7).
//
//   GET  /api/iris/knowledge?version=4.6.71   the manual pack for that version (or the nearest earlier one); public
//   POST /api/iris/knowledge                  CI publishes a pack (x-admin-secret)
//   GET  /api/iris/capability                 what this license gets: voice flags + this month's use (x-license-key)
//   POST /api/iris/ask                        { version, question, sectionIds[], settings[], history[] } → answer
//   POST /api/iris/speak, /api/iris/listen    voice: designed in, not built yet (501)
//
// The answer is built from the matching manual sections ONLY (Jeff: "Don't send the whole manual with each question"),
// looked up here by id in that version's pack, plus the read-only settings snapshot the desktop sends. Iris can't
// change anything: the reply is text. Model: Claude Haiku 5.5 (Jeff, 2026-11-04, decision 1).
// Fair use: 300 AI questions per license per month, and a hard $3.00 meter of what was really spent.

const express = require("express");

const MODEL = "claude-haiku-5-5";
// Anthropic list prices, Claude Haiku 5.5, prompts up to 100,000 tokens (platform.claude.com pricing, checked
// 2026-11-04), in micro-dollars per token. A prompt over 100K pays the higher row; Iris prompts are a few thousand.
const PRICE = { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125 };   // $ per million tokens = µ$ per token
const PRICE_LONG = { input: 0.50, output: 2.50, cacheRead: 0.05, cacheWrite: 0.625 };
const LIMITS = { aiQuestions: 300, budgetMicros: 3_000_000 };
const MAX_SECTIONS = 4, MAX_SECTION_CHARS = 3000, MAX_QUESTION_CHARS = 600, MAX_SETTINGS = 40, MAX_HISTORY = 2;

// Voice allowances per month (ElevenLabs, decision 2). Local: spoken answers; every other plan: spoken questions and
// answers (decisions 3 and 5: Lifetime, platform-made and Free (old key) licenses get this top tier).
const VOICE = {
  local: { speakAnswers: true, speakQuestions: false, spokenPerMonth: 110 },
  top:   { speakAnswers: true, speakQuestions: true,  spokenPerMonth: 100 },
};
// Voice is designed in and not built: the desktop gets the plan's voice tier, and `voiceBuilt` says it is not on yet.
const VOICE_BUILT = false;

function irisTier(license) { return license && license.plan === "local" ? "local" : "top"; }

/** What one answer cost, in micro-dollars, from the API's usage block. */
function costMicros(usage) {
  if (!usage) return 0;
  const inTok = (usage.input_tokens || 0), cr = (usage.cache_read_input_tokens || 0), cw = (usage.cache_creation_input_tokens || 0);
  const p = (inTok + cr + cw) > 100_000 ? PRICE_LONG : PRICE;
  return Math.ceil(inTok * p.input + cr * p.cacheRead + cw * p.cacheWrite + (usage.output_tokens || 0) * p.output);
}

function monthOf(d = new Date()) { return d.toISOString().slice(0, 7); }

const SYSTEM = `You are Iris, the help assistant built into Ether, a radio broadcast automation app. You answer questions
about using Ether, and general broadcast questions, for the person running the station.

Rules:
- Answer only from the MANUAL SECTIONS given with the question, plus general broadcast knowledge (loudness, streaming,
  radio programming terms). Never invent a button, menu, setting or feature that the sections do not show.
- If the sections don't cover the question, say so plainly and suggest the closest section, or say the manual doesn't
  cover it.
- When THIS STATION'S SETTINGS answer part of the question, say what this station is set to and where to change it, in
  the "yours" list, for example "Your loudness target is -16 LUFS. Change it in File → Settings → Audio → Loudness &
  faders." Use only values given in the settings; never guess one.
- You can't change anything in Ether. If asked to, say how the person can do it themselves.
- Write plainly and briefly: short sentences, numbered steps for a procedure, button names in bold as the manual shows
  them. No greetings, no filler.
- "chapters" lists the ids of the sections you used, most useful first.`;

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    yours: { type: "array", items: { type: "string" } },
    chapters: { type: "array", items: { type: "string" } },
    covered: { type: "boolean" },
  },
  required: ["answer", "yours", "chapters", "covered"],
  additionalProperties: false,
};

function clip(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) + "…" : s; }

/** The user turn: the matching sections, this station's settings, the question. (The system prompt is the cached part.) */
function buildUserTurn({ sections, settings, question }) {
  const sec = sections.map(s =>
    `<section id="${s.id}" where="${s.chapter != null ? `Manual chapter ${s.chapter}, ${s.chapterTitle}` : s.chapterTitle}" title="${s.title}">\n${clip(s.text, MAX_SECTION_CHARS)}\n</section>`).join("\n");
  const set = settings.length
    ? settings.map(x => `- ${clip(x.label, 80)}: ${clip(x.value, 120)}${x.where ? ` (change it in ${clip(x.where, 120)})` : ""}`).join("\n")
    : "(none sent)";
  return `MANUAL SECTIONS\n${sec || "(no matching sections)"}\n\nTHIS STATION'S SETTINGS (read-only)\n${set}\n\nQUESTION\n${clip(question, MAX_QUESTION_CHARS)}`;
}

function cmpVersion(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

module.exports = function irisRouter(pool, lookupLicense, { anthropic = null, adminSecret = () => process.env.ADMIN_SECRET } = {}) {
  const router = express.Router();
  let ready = null;
  const ensure = () => ready || (ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS iris_knowledge (
      version TEXT PRIMARY KEY, pack JSONB NOT NULL, published_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS iris_usage (
      license_id INTEGER NOT NULL, month TEXT NOT NULL,
      ai_questions INTEGER NOT NULL DEFAULT 0, manual_answers INTEGER NOT NULL DEFAULT 0,
      spoken INTEGER NOT NULL DEFAULT 0, cost_micros BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (license_id, month))`);
  })().catch(e => { ready = null; throw e; }));

  const packs = new Map();   // version → pack, in memory (a pack changes only when CI republishes it)
  async function packFor(version) {
    await ensure();
    const { rows } = await pool.query(`SELECT version FROM iris_knowledge`);
    const best = rows.map(r => r.version).filter(v => cmpVersion(v, version) <= 0).sort(cmpVersion).pop()
      || rows.map(r => r.version).sort(cmpVersion)[0];
    if (!best) return null;
    if (!packs.has(best)) {
      const r = await pool.query(`SELECT pack FROM iris_knowledge WHERE version = $1`, [best]);
      const p = r.rows[0] && (typeof r.rows[0].pack === "string" ? JSON.parse(r.rows[0].pack) : r.rows[0].pack);
      if (!p) return null;
      packs.set(best, { pack: p, byId: new Map(p.sections.map(s => [s.id, s])) });
    }
    return packs.get(best);
  }

  async function usageOf(licenseId, month = monthOf()) {
    await ensure();
    const { rows } = await pool.query(`SELECT * FROM iris_usage WHERE license_id = $1 AND month = $2`, [licenseId, month]);
    const r = rows[0] || {};
    return { month, aiQuestions: Number(r.ai_questions || 0), manualAnswers: Number(r.manual_answers || 0),
             spoken: Number(r.spoken || 0), costMicros: Number(r.cost_micros || 0) };
  }
  async function addUsage(licenseId, { ai = 0, manual = 0, micros = 0 }) {
    await pool.query(`INSERT INTO iris_usage (license_id, month, ai_questions, manual_answers, cost_micros)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (license_id, month) DO UPDATE SET ai_questions = iris_usage.ai_questions + $3,
        manual_answers = iris_usage.manual_answers + $4, cost_micros = iris_usage.cost_micros + $5`,
      [licenseId, monthOf(), ai, manual, micros]);
  }

  async function license(req, res) {
    const key = req.headers["x-license-key"];
    if (!key) { res.status(401).json({ ok: false, error: "missing_license_key" }); return null; }
    const lic = await lookupLicense(String(key)).catch(() => null);
    if (!lic) { res.status(401).json({ ok: false, error: "invalid_license_key" }); return null; }
    return lic;
  }
  function capabilityOf(lic, use) {
    const tier = irisTier(lic), v = VOICE[tier];
    return {
      tier, voiceBuilt: VOICE_BUILT,
      speakAnswers: VOICE_BUILT && v.speakAnswers, speakQuestions: VOICE_BUILT && v.speakQuestions,
      allowance: { aiQuestions: LIMITS.aiQuestions, spoken: v.spokenPerMonth },
      used: { aiQuestions: use.aiQuestions, spoken: use.spoken },
      budgetLeft: Math.max(0, LIMITS.budgetMicros - use.costMicros) > 0,
    };
  }

  // ── knowledge ──
  router.get("/knowledge", async (req, res) => {
    try {
      const p = await packFor(String(req.query.version || "0"));
      if (!p) return res.status(404).json({ ok: false, error: "no_pack" });
      const etag = `"${p.pack.version}-${p.pack.builtAt}"`;
      res.setHeader("ETag", etag);
      if (req.headers["if-none-match"] === etag) return res.status(304).end();
      res.json(p.pack);
    } catch (e) { res.status(500).json({ ok: false, error: "knowledge_failed" }); }
  });
  router.post("/knowledge", async (req, res) => {
    const want = adminSecret();
    if (!want || req.headers["x-admin-secret"] !== want) return res.status(403).json({ ok: false, error: "forbidden" });
    const p = req.body;
    if (!p || p.v !== 1 || !p.version || !Array.isArray(p.sections) || !p.sections.length) return res.status(400).json({ ok: false, error: "bad_pack" });
    try {
      await ensure();
      await pool.query(`INSERT INTO iris_knowledge (version, pack) VALUES ($1, $2::jsonb)
        ON CONFLICT (version) DO UPDATE SET pack = EXCLUDED.pack, published_at = NOW()`, [String(p.version), JSON.stringify(p)]);
      packs.delete(String(p.version));
      res.json({ ok: true, version: String(p.version), sections: p.sections.length });
    } catch (e) { res.status(500).json({ ok: false, error: "publish_failed" }); }
  });

  // ── capability ──
  router.get("/capability", async (req, res) => {
    const lic = await license(req, res); if (!lic) return;
    try { res.json({ ok: true, ...capabilityOf(lic, await usageOf(lic.id)) }); }
    catch { res.status(500).json({ ok: false, error: "capability_failed" }); }
  });

  // ── ask ──
  router.post("/ask", async (req, res) => {
    const lic = await license(req, res); if (!lic) return;
    const b = req.body || {};
    const question = String(b.question || "").trim();
    if (!question) return res.status(400).json({ ok: false, error: "no_question" });
    try {
      const use = await usageOf(lic.id);
      const cap = capabilityOf(lic, use);
      // Fair use: over 300 AI questions this month, or the $3 meter spent → the desktop answers from the manual.
      if (use.aiQuestions >= LIMITS.aiQuestions || use.costMicros >= LIMITS.budgetMicros)
        return res.json({ ok: true, mode: "limit", capability: cap });
      if (!anthropic) return res.status(503).json({ ok: false, error: "ai_not_configured" });
      const p = await packFor(String(b.version || "0"));
      if (!p) return res.status(503).json({ ok: false, error: "no_pack" });
      const ids = (Array.isArray(b.sectionIds) ? b.sectionIds : []).slice(0, MAX_SECTIONS).map(String);
      const sections = ids.map(id => p.byId.get(id)).filter(Boolean);
      const settings = (Array.isArray(b.settings) ? b.settings : []).slice(0, MAX_SETTINGS)
        .filter(x => x && x.label != null && x.value != null);
      const history = (Array.isArray(b.history) ? b.history : []).slice(-MAX_HISTORY)
        .filter(h => h && typeof h.q === "string" && typeof h.a === "string")
        .flatMap(h => [{ role: "user", content: clip(h.q, MAX_QUESTION_CHARS) }, { role: "assistant", content: clip(h.a, 1500) }]);

      const msg = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2000,
        output_config: { effort: "low", format: { type: "json_schema", schema: ANSWER_SCHEMA } },
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [...history, { role: "user", content: buildUserTurn({ sections, settings, question }) }],
      });
      const micros = costMicros(msg.usage);
      await addUsage(lic.id, { ai: 1, micros });
      if (msg.stop_reason === "refusal") return res.json({ ok: true, mode: "ai", answer: "I can't help with that one. Try asking about Ether or your station.", yours: [], chapters: [], covered: false, capability: cap });
      const text = (msg.content || []).filter(c => c.type === "text").map(c => c.text).join("");
      let out; try { out = JSON.parse(text); } catch { out = { answer: text, yours: [], chapters: [], covered: true }; }
      const known = new Set(sections.map(s => s.id));
      res.json({
        ok: true, mode: "ai",
        answer: String(out.answer || ""), yours: (out.yours || []).map(String).slice(0, 6),
        chapters: (out.chapters || []).map(String).filter(id => known.has(id)),
        covered: out.covered !== false,
        capability: capabilityOf(lic, { ...use, aiQuestions: use.aiQuestions + 1, costMicros: use.costMicros + micros }),
      });
    } catch (e) {
      console.error("[iris] ask failed:", e && e.message);
      res.status(502).json({ ok: false, error: "ask_failed" });
    }
  });

  // A manual-only answer the desktop gave on its own: counted (no cost), so the month's use is honest.
  router.post("/manual-answer", async (req, res) => {
    const lic = await license(req, res); if (!lic) return;
    try { await addUsage(lic.id, { manual: 1 }); res.json({ ok: true }); }
    catch { res.status(500).json({ ok: false }); }
  });

  // ── voice: designed in, not built (Stage 1 is typed questions, text answers) ──
  router.post("/speak", (_req, res) => res.status(501).json({ ok: false, error: "voice_not_built" }));
  router.post("/listen", (_req, res) => res.status(501).json({ ok: false, error: "voice_not_built" }));

  return router;
};

module.exports.costMicros = costMicros;
module.exports.irisTier = irisTier;
module.exports.buildUserTurn = buildUserTurn;
module.exports.cmpVersion = cmpVersion;
module.exports.LIMITS = LIMITS;
module.exports.VOICE = VOICE;
module.exports.MODEL = MODEL;
