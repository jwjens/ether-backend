/**
 * Ether Technologies — Railway Backend  src/index.js
 * ─────────────────────────────────────────────────
 * Routes:
 *   GET  /                        Landing page (served from public/)
 *   GET  /mobile                  Now Playing mobile PWA
 *   GET  /companion               Companion control app
 *   GET  /join/:token             Guest join page
 *   GET  /health                  Health check
 *
 *   POST /validate                Validate license key
 *   POST /webhook/stripe          Stripe payment → issue license + Resend email
 *   GET  /admin/licenses          List all licenses  (x-admin-secret header)
 *   POST /admin/issue             Manually issue license (x-admin-secret header)
 *
 *   POST /guest/join              Register guest presence
 *   POST /guest/leave             Remove guest
 *   GET  /guest/status/:token     Check guest status
 *
 *   POST /api/now-playing         Desktop pushes now-playing state
 *   GET  /api/now-playing         Mobile polls now-playing state
 *   POST /api/cmd                 Companion sends command → desktop
 *   GET  /api/pending-cmds        Desktop polls queued commands
 *
 *   POST /backup/upload           Upload gzipped backup  (Pro+, needs multer)
 *   GET  /backup/list             List backups           (Pro+)
 *   GET  /backup/download/:id     Download backup        (Pro+)
 *   DELETE /backup/:id            Delete backup          (Pro+)
 *
 * Required Railway env vars (already set):
 *   DATABASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
 *   RESEND_API_KEY, PRICE_PRO, PRICE_STATION, ADMIN_SECRET
 *
 * Add these two:
 *   BACKUP_MAX_MB = 50
 *   FROM_EMAIL    = noreply@etherradio.app
 */

require("dotenv").config();

const express    = require("express");
const cors       = require("cors");
const crypto     = require("crypto");
const path       = require("path");
const zlib       = require("zlib");
const { Pool }   = require("pg");
const { Resend } = require("resend");
const bcrypt     = require('bcrypt');

// multer is optional — install with: npm install multer
let multer;
try { multer = require("multer"); } catch { multer = null; }

const app    = express();
const pool   = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const resend = new Resend(process.env.RESEND_API_KEY);

// ── In-memory state ───────────────────────────────────────────
const pendingCmds = [];          // fallback queue when no SSE client is connected
const sseClients  = new Map();   // license_key → Set<res> for cmd-stream subscribers
const nowPlaying  = { data: null };  // desktop pushes, mobile polls

// ── Middleware ────────────────────────────────────────────────

app.use("/webhook/stripe", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "10mb" }));
app.use(cors({ origin: "*" }));

// Serve landing, mobile.html, companion.html, guest-join.html from public/
const PUBLIC = path.join(__dirname, "../public");
app.use(express.static(PUBLIC));

const upload = multer
  ? multer({ storage: multer.memoryStorage(), limits: { fileSize: (parseInt(process.env.BACKUP_MAX_MB) || 50) * 1024 * 1024 } })
  : null;

// ── DB init ───────────────────────────────────────────────────

// Per-plan machine activation limits.
// A single license can be active on this many machines simultaneously.
// Users can deactivate machines to free up slots.
const PLAN_MACHINE_LIMITS = { free: 1, pro: 2, station: 5 };

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS licenses (
      id              SERIAL PRIMARY KEY,
      email           TEXT NOT NULL,
      license_key     TEXT NOT NULL UNIQUE,
      plan            TEXT NOT NULL DEFAULT 'pro',
      stripe_sub_id   TEXT,
      active          BOOLEAN DEFAULT true,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      last_validated  TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS license_activations (
      id              SERIAL PRIMARY KEY,
      license_key     TEXT NOT NULL,
      machine_id      TEXT NOT NULL,
      machine_name    TEXT,
      os              TEXT,
      ip_address      TEXT,
      activated_at    TIMESTAMPTZ DEFAULT NOW(),
      last_seen       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(license_key, machine_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backups (
      id           SERIAL PRIMARY KEY,
      station_id   TEXT NOT NULL,
      license_key  TEXT NOT NULL,
      filename     TEXT NOT NULL,
      size_bytes   INTEGER NOT NULL,
      checksum     TEXT NOT NULL,
      data         BYTEA NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      description  TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guest_presence (
      token      TEXT PRIMARY KEY,
      name       TEXT,
      has_video  BOOLEAN DEFAULT false,
      joined_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_licenses_key      ON licenses(license_key)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_licenses_email    ON licenses(email)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activations_key   ON license_activations(license_key)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_backups_station   ON backups(station_id)`);
  await pool.query(`DELETE FROM guest_presence WHERE joined_at < NOW() - INTERVAL '24 hours'`).catch(() => {});

  // Schema migrations: original DB used status TEXT and lacked active/last_validated.
  // ADD COLUMN IF NOT EXISTS backfills existing rows with the declared DEFAULT.
  await pool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`);
  await pool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS last_validated TIMESTAMPTZ`);
  // Allow NULL license_key for new bcrypt-format rows (key stored as key_hash + key_prefix only).
  // Idempotent: no-op if column is already nullable.
  await pool.query(`ALTER TABLE licenses ALTER COLUMN license_key DROP NOT NULL`);

  // ── Sync mutations table — Ether sync protocol §17–§18 ─────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mutations (
      server_seq          BIGSERIAL NOT NULL,
      id                  TEXT PRIMARY KEY,
      client_id           TEXT NOT NULL,
      station_id          TEXT,
      actor_id            TEXT,
      table_name          TEXT NOT NULL,
      row_id              TEXT NOT NULL,
      op                  TEXT NOT NULL,
      payload_before      JSONB,
      payload_after       JSONB,
      created_at          TIMESTAMPTZ NOT NULL,
      hlc                 TEXT NOT NULL,
      parent_mutation_id  TEXT,
      schema_version      INTEGER NOT NULL,
      conflict_resolution JSONB,
      received_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mutations_seq     ON mutations(server_seq)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mutations_sta_seq ON mutations(station_id, server_seq)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mutations_client  ON mutations(client_id)`);

  console.log("[DB] Schema ready");
}

// ── Helpers ───────────────────────────────────────────────────

function generateLicenseKey(plan) {
  const prefix = plan === "station" ? "ETH-STN" : "ETH-PRO";
  const rand   = crypto.randomBytes(12).toString("hex").toUpperCase();
  return `${prefix}-${rand.slice(0,4)}-${rand.slice(4,8)}-${rand.slice(8,12)}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendLicenseEmail(email, licenseKey, plan) {
  const label = plan === "station" ? "Station" : "Pro";
  const price = plan === "station" ? "$79/mo" : "$19/mo";
  const from  = process.env.FROM_EMAIL || "noreply@etherradio.app";

  const { error } = await resend.emails.send({
    from, to: email,
    subject: `Your Ether Technologies ${label} License Key`,
    html: `
<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#0d0d18;color:#f0f0f8;border-radius:12px">
  <div style="font-size:22px;font-weight:900;color:#22d3ee;letter-spacing:-0.5px;margin-bottom:3px">Ether Technologies</div>
  <div style="font-size:10px;letter-spacing:2.5px;text-transform:uppercase;color:#475569;margin-bottom:28px">Broadcast Automation Platform</div>
  <p style="font-size:16px;font-weight:700;margin-bottom:10px">Your ${label} License Key</p>
  <p style="color:#94a3b8;font-size:13px;line-height:1.7;margin-bottom:24px">
    Thank you for subscribing to Ether ${label} (${price}). Save this email — you'll need the key if you reinstall.
  </p>
  <div style="background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:22px;margin-bottom:24px;text-align:center">
    <div style="font-size:9px;color:#475569;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px">License Key</div>
    <div style="font-family:'Courier New',monospace;font-size:19px;font-weight:800;color:#22d3ee;letter-spacing:2.5px">${licenseKey}</div>
  </div>
  <div style="background:#0a1520;border-radius:8px;padding:16px 18px;margin-bottom:22px">
    <div style="font-size:12px;font-weight:700;color:#e2e8f0;margin-bottom:10px">How to activate</div>
    <ol style="color:#94a3b8;font-size:12px;line-height:2.2;padding-left:18px;margin:0">
      <li>Open <strong style="color:#f0f0f8">Ether</strong> on your computer</li>
      <li>Click the <strong style="color:#f0f0f8">Pro</strong> button in the top toolbar</li>
      <li>Click <strong style="color:#f0f0f8">Enter License Key</strong></li>
      <li>Enter your email and the key above</li>
    </ol>
  </div>
  <p style="color:#475569;font-size:11px">
    Questions? <a href="mailto:support@etherradio.app" style="color:#22d3ee;text-decoration:none">support@etherradio.app</a>
  </p>
  <div style="margin-top:28px;padding-top:14px;border-top:1px solid #1e293b;font-size:10px;color:#334155">
    Ether Technologies · etherradio.app · ${new Date().getFullYear()}
  </div>
</div>`,
  });
  if (error) throw new Error(JSON.stringify(error));
}

// ── Auth middleware ───────────────────────────────────────────

async function requireLicense(req, res, next) {
  const key = req.headers["x-license-key"];
  if (!key) return res.status(401).json({ error: "Missing x-license-key header" });

  // Two-path lookup per B-12:
  //   New keys (bcrypt): matched by key_prefix (first 12 chars = ETH-PRO-XXXX / ETH-STN-XXXX,
  //     ~65k unique values), authenticated via bcrypt.compare against key_hash. license_key is NULL.
  //   Old keys (plaintext): matched by license_key column, authenticated by direct string equality.
  // Single OR query returns candidates for both paths; loop authenticates each.
  const prefix = key.slice(0, 12);
  const { rows } = await pool.query(
    `SELECT * FROM licenses
     WHERE (key_prefix = $1 OR license_key = $2) AND active = true`,
    [prefix, key]
  ).catch(() => ({ rows: [] }));

  let license = null;
  for (const row of rows) {
    if (row.key_hash != null) {
      if (await bcrypt.compare(key, row.key_hash)) { license = row; break; }
    } else if (key === row.license_key) {
      license = row;
      break;
    }
  }

  if (!license) return res.status(401).json({ error: "invalid_license_key" });
  if (!["pro", "station"].includes(license.plan))
    return res.status(403).json({ error: "Pro or Station plan required" });
  req.license = license;
  next();
}

function requireAdmin(req, res, next) {
  const s = req.headers["x-admin-secret"] || req.query.secret;
  if (s !== process.env.ADMIN_SECRET) return res.status(403).json({ error: "Forbidden" });
  next();
}

// ── Static page fallbacks ────────────────────────────────────

app.get("/mobile",      (req, res) => res.sendFile(path.join(PUBLIC, "mobile.html")));
app.get("/companion",   (req, res) => res.sendFile(path.join(PUBLIC, "companion.html")));
app.get("/join/:token", (req, res) => res.sendFile(path.join(PUBLIC, "guest-join.html")));
app.get("/dashboard",   (req, res) => res.sendFile(path.join(PUBLIC, "dashboard.html")));
app.get("/emergency",   (req, res) => res.sendFile(path.join(PUBLIC, "emergency.html")));
app.get("/console",     (req, res) => res.sendFile(path.join(PUBLIC, "console.html")));

// ── Health ────────────────────────────────────────────────────

app.get("/health", (req, res) =>
  res.json({ ok: true, service: "Ether Technologies API", version: "1.5.2", ts: new Date().toISOString() })
);

// ── License validation ────────────────────────────────────────

app.post("/validate", async (req, res) => {
  try {
    const { license_key, email, machine_id, machine_name, os } = req.body;
    if (!license_key?.trim() || !email?.trim())
      return res.status(400).json({ valid: false, error: "Missing license_key or email" });
    if (!machine_id?.trim())
      return res.status(400).json({ valid: false, error: "Missing machine_id — please update to the latest Ether version." });

    // 1. Verify license exists and is active for this email
    const { rows } = await pool.query(
      "SELECT * FROM licenses WHERE license_key=$1 AND email=$2 AND active=true",
      [license_key.trim(), email.trim().toLowerCase()]
    );
    if (!rows.length)
      return res.json({ valid: false, error: "License key not found or does not match this email." });

    const license = rows[0];
    const limit = PLAN_MACHINE_LIMITS[license.plan] ?? 1;
    const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "").trim();

    // 2. Check if this machine is already activated for this license
    const { rows: existingActivations } = await pool.query(
      "SELECT * FROM license_activations WHERE license_key=$1 AND machine_id=$2",
      [license.license_key, machine_id.trim()]
    );

    if (existingActivations.length) {
      // Already activated on this machine → just update last_seen
      await pool.query(
        "UPDATE license_activations SET last_seen=NOW(), ip_address=$1 WHERE id=$2",
        [ip, existingActivations[0].id]
      );
    } else {
      // 3. Not activated here — check if we have room
      const { rows: activeList } = await pool.query(
        "SELECT machine_id, machine_name, os, activated_at, last_seen FROM license_activations WHERE license_key=$1 ORDER BY last_seen DESC",
        [license.license_key]
      );

      if (activeList.length >= limit) {
        return res.status(403).json({
          valid: false,
          error: "activation_limit_reached",
          message: `This license is already active on ${activeList.length} of ${limit} allowed machines. Deactivate one to install here.`,
          limit,
          plan: license.plan,
          activations: activeList,
        });
      }

      // 4. Register this machine as a new activation
      await pool.query(
        "INSERT INTO license_activations (license_key, machine_id, machine_name, os, ip_address) VALUES ($1,$2,$3,$4,$5)",
        [license.license_key, machine_id.trim(), machine_name || null, os || null, ip]
      );
      console.log(`[Activation] ${license.license_key} → ${machine_name || machine_id.slice(0, 8)} (${activeList.length + 1}/${limit})`);
    }

    await pool.query("UPDATE licenses SET last_validated=NOW() WHERE id=$1", [license.id]);
    res.json({
      valid: true,
      plan: license.plan,
      email: license.email,
      machine_limit: limit,
      license_key: license.license_key,
    });
  } catch (e) {
    console.error("[/validate]", e.message);
    res.status(500).json({ valid: false, error: "Server error — please try again." });
  }
});

// ── License activations ───────────────────────────────────────
//
// GET /licenses/:key/activations  → list of machines this license is active on
// POST /licenses/:key/deactivate  → remove a machine from this license
//     body: { email, machine_id }  (email acts as a lightweight owner check)

app.get("/licenses/:key/activations", async (req, res) => {
  try {
    const key = req.params.key.trim();
    const email = (req.query.email || "").toString().trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Missing email query param" });

    const { rows: lic } = await pool.query(
      "SELECT * FROM licenses WHERE license_key=$1 AND email=$2 AND active=true",
      [key, email]
    );
    if (!lic.length) return res.status(404).json({ error: "License not found" });

    const { rows: activations } = await pool.query(
      "SELECT machine_id, machine_name, os, ip_address, activated_at, last_seen FROM license_activations WHERE license_key=$1 ORDER BY last_seen DESC",
      [key]
    );
    const limit = PLAN_MACHINE_LIMITS[lic[0].plan] ?? 1;
    res.json({ plan: lic[0].plan, limit, activations });
  } catch (e) {
    console.error("[/licenses/:key/activations]", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/licenses/:key/deactivate", async (req, res) => {
  try {
    const key = req.params.key.trim();
    const { email, machine_id } = req.body;
    if (!email?.trim() || !machine_id?.trim())
      return res.status(400).json({ error: "Missing email or machine_id" });

    const { rows: lic } = await pool.query(
      "SELECT * FROM licenses WHERE license_key=$1 AND email=$2 AND active=true",
      [key, email.trim().toLowerCase()]
    );
    if (!lic.length) return res.status(404).json({ error: "License not found" });

    const { rowCount } = await pool.query(
      "DELETE FROM license_activations WHERE license_key=$1 AND machine_id=$2",
      [key, machine_id.trim()]
    );
    console.log(`[Deactivation] ${key} → ${machine_id.slice(0, 8)} (removed ${rowCount})`);
    res.json({ ok: true, removed: rowCount });
  } catch (e) {
    console.error("[/licenses/:key/deactivate]", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Admin endpoints ───────────────────────────────────────────

app.get("/admin/licenses", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id,email,license_key,plan,active,created_at,last_validated FROM licenses ORDER BY created_at DESC LIMIT 500"
  );
  res.json(rows);
});

app.post("/admin/issue", requireAdmin, async (req, res) => {
  const { email, plan = "pro" } = req.body;
  if (!email) return res.status(400).json({ error: "Missing email" });
  const key = generateLicenseKey(plan);
  const keyPrefix = key.slice(0, 12);
  const keyHash   = await bcrypt.hash(key, 12);
  await pool.query(
    "INSERT INTO licenses (email,plan,key_prefix,key_hash) VALUES ($1,$2,$3,$4)",
    [email.toLowerCase(), plan, keyPrefix, keyHash]
  );
  try { await sendLicenseEmail(email, key, plan); } catch (e) { console.error("[Email]", e.message); }
  res.json({ ok: true, license_key: key, plan, email });
});

// ── Stripe webhook ────────────────────────────────────────────

app.post("/webhook/stripe", async (req, res) => {
  const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error("[Stripe] Signature failed:", e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  console.log(`[Stripe] ${event.type}`);

  if (["checkout.session.completed","invoice.payment_succeeded"].includes(event.type)) {
    const obj   = event.data.object;
    const email = (obj.customer_email || obj.customer_details?.email || "").toLowerCase().trim();
    const subId = obj.subscription || obj.id;
    if (!email) { console.warn("[Stripe] No email"); return res.json({ received: true }); }

    const items   = obj.lines?.data || [];
    const priceId = items[0]?.price?.id || "";
    const plan    = priceId === process.env.PRICE_STATION ? "station" : "pro";

    const { rows: existing } = await pool.query("SELECT * FROM licenses WHERE stripe_sub_id=$1", [subId]);
    let licenseKey;
    if (existing.length) {
      await pool.query("UPDATE licenses SET active=true, email=$1 WHERE id=$2", [email, existing[0].id]);
      licenseKey = existing[0].license_key;
      console.log(`[License] Reactivated: ${licenseKey} → ${email}`);
    } else {
      licenseKey = generateLicenseKey(plan);
      const keyPrefix = licenseKey.slice(0, 12);
      const keyHash   = await bcrypt.hash(licenseKey, 12);
      await pool.query(
        "INSERT INTO licenses (email,plan,stripe_sub_id,key_prefix,key_hash) VALUES ($1,$2,$3,$4,$5)",
        [email, plan, subId, keyPrefix, keyHash]
      );
      console.log(`[License] Issued: ${keyPrefix}... → ${email} (${plan})`);
      try { await sendLicenseEmail(email, licenseKey, plan); }
      catch (e) { console.error("[Email]", e.message); }
    }
  }

  if (["customer.subscription.deleted","invoice.payment_failed"].includes(event.type)) {
    const subId = event.data.object.id;
    const { rowCount } = await pool.query("UPDATE licenses SET active=false WHERE stripe_sub_id=$1", [subId]);
    console.log(`[License] Deactivated sub ${subId} (${rowCount} rows)`);
  }

  res.json({ received: true });
});

// ── Now Playing ───────────────────────────────────────────────

app.post("/api/now-playing", (req, res) => {
  nowPlaying.data = { ...req.body, updated_at: Date.now() };
  res.json({ ok: true });
});

app.get("/api/now-playing", (req, res) => {
  res.json(nowPlaying.data || { playing: false, title: null, artist: null, position: 0, duration: 0, queue: [], history: [] });
});

// ── Companion command bus ─────────────────────────────────────

app.post("/api/cmd", requireLicense, (req, res) => {
  const { cmd } = req.body;
  if (!cmd) return res.status(400).json({ error: "Missing cmd" });

  const key     = req.license.license_key;
  const payload = JSON.stringify({ cmd, data: req.body, ts: Math.floor(Date.now() / 1000) });
  const clients = sseClients.get(key);

  if (clients && clients.size > 0) {
    // Instant fan-out to all connected SSE streams for this license key
    for (const client of clients) {
      if (!client.writableEnded) client.write(`event: cmd\ndata: ${payload}\n\n`);
    }
    console.log(`[cmd] ${cmd} → SSE fan-out to ${clients.size} client(s) for key=${key.slice(0,8)}`);
  } else {
    // No SSE client connected — fall back to in-memory queue
    pendingCmds.push({ cmd, data: req.body, ts: Math.floor(Date.now() / 1000) });
    if (pendingCmds.length > 20) pendingCmds.splice(0, pendingCmds.length - 20);
  }

  res.json({ ok: true });
});

// SSE: Ether desktop subscribes here for instant command delivery.
// EventSource API cannot set custom headers, so license key comes from ?key= query param.
app.get("/api/cmd-stream", async (req, res) => {
  const key = req.headers["x-license-key"] || req.query.key || "";
  if (!key) return res.status(401).json({ error: "Missing x-license-key header or ?key= param" });

  const { rows } = await pool.query(
    "SELECT * FROM licenses WHERE license_key=$1 AND active=true", [key]
  ).catch(() => ({ rows: [] }));
  if (!rows.length) return res.status(403).json({ error: "Invalid or inactive license" });
  if (!["pro","station"].includes(rows[0].plan))
    return res.status(403).json({ error: "Pro or Station plan required" });

  res.set({
    "Content-Type":      "text/event-stream",
    "Cache-Control":     "no-cache",
    "X-Accel-Buffering": "no",   // disable Railway/Nginx proxy buffering
    "Connection":        "keep-alive",
  });
  res.flushHeaders();

  if (!sseClients.has(key)) sseClients.set(key, new Set());
  const clients = sseClients.get(key);
  clients.add(res);
  console.log(`[cmd-stream] connected — key=${key.slice(0,8)} streams=${clients.size}`);

  // Drain any commands queued before this connection arrived
  if (pendingCmds.length > 0) {
    const buffered = pendingCmds.splice(0);
    for (const c of buffered) {
      res.write(`event: cmd\ndata: ${JSON.stringify(c)}\n\n`);
    }
  }

  // Keepalive comment every 15 s — prevents Railway's 60 s idle timeout
  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, 15_000);

  res.on("close", () => {
    clearInterval(keepalive);
    clients.delete(res);
    if (clients.size === 0) sseClients.delete(key);
    console.log(`[cmd-stream] disconnected — key=${key.slice(0,8)} streams=${clients.size}`);
  });
});

app.get("/api/pending-cmds", requireLicense, (req, res) => {
  const out = [...pendingCmds];
  pendingCmds.length = 0;
  res.json(out);
});

// ── Guest presence ────────────────────────────────────────────

app.post("/guest/join", async (req, res) => {
  const { token, name, hasVideo } = req.body;
  if (!token) return res.status(400).json({ error: "Missing token" });
  await pool.query(
    `INSERT INTO guest_presence (token,name,has_video) VALUES ($1,$2,$3)
     ON CONFLICT (token) DO UPDATE SET name=$2, has_video=$3, joined_at=NOW()`,
    [token, name || "Guest", !!hasVideo]
  ).catch(e => { console.error("[guest/join]", e.message); });
  res.json({ ok: true });
});

app.post("/guest/leave", async (req, res) => {
  if (req.body.token) await pool.query("DELETE FROM guest_presence WHERE token=$1", [req.body.token]).catch(() => {});
  res.json({ ok: true });
});

app.get("/guest/status/:token", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM guest_presence WHERE token=$1", [req.params.token]).catch(() => ({ rows: [] }));
  if (!rows.length) return res.json({ connected: false });
  res.json({ connected: true, name: rows[0].name, hasVideo: rows[0].has_video });
});

// ── Cloud Backup ──────────────────────────────────────────────

app.post("/backup/upload", requireLicense, (req, res) => {
  if (!upload) return res.status(503).json({ error: "multer not installed — run: npm install multer" });
  upload.single("backup")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file provided" });
    try {
      try {
        JSON.parse(zlib.gunzipSync(req.file.buffer).toString("utf8"));
      } catch {
        return res.status(400).json({ error: "Invalid backup — must be valid gzipped JSON" });
      }
      const stationId   = req.body.station_id || req.license.email;
      const description = req.body.description || null;
      const filename    = req.body.filename    || `backup_${Date.now()}.json.gz`;
      const checksum    = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
      const sizeBytes   = req.file.buffer.length;

      if (req.license.plan === "pro") {
        const { rows: [{ count }] } = await pool.query("SELECT COUNT(*) FROM backups WHERE station_id=$1", [stationId]);
        if (parseInt(count) >= 30) {
          await pool.query("DELETE FROM backups WHERE id=(SELECT id FROM backups WHERE station_id=$1 ORDER BY created_at ASC LIMIT 1)", [stationId]);
        }
      }

      const { rows: [row] } = await pool.query(
        `INSERT INTO backups (station_id,license_key,filename,size_bytes,checksum,data,description)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,created_at`,
        [stationId, req.license.license_key, filename, sizeBytes, checksum, req.file.buffer, description]
      );
      res.json({ success: true, backup_id: row.id, created_at: row.created_at, size_bytes: sizeBytes, checksum });
    } catch (e) {
      console.error("[backup/upload]", e.message);
      res.status(500).json({ error: "Upload failed" });
    }
  });
});

app.get("/backup/list", requireLicense, async (req, res) => {
  try {
    const stationId = req.query.station_id || req.license.email;
    const { rows } = await pool.query(
      "SELECT id,filename,size_bytes,checksum,created_at,description FROM backups WHERE station_id=$1 ORDER BY created_at DESC",
      [stationId]
    );
    const { rows: [{ total }] } = await pool.query(
      "SELECT COALESCE(SUM(size_bytes),0) as total FROM backups WHERE station_id=$1", [stationId]
    );
    res.json({ backups: rows, total_size_bytes: parseInt(total), plan: req.license.plan, limit: req.license.plan === "pro" ? 30 : null });
  } catch (e) {
    console.error("[backup/list]", e.message);
    res.status(500).json({ error: "List failed" });
  }
});

app.get("/backup/download/:id", requireLicense, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM backups WHERE id=$1 AND license_key=$2", [req.params.id, req.license.license_key]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${rows[0].filename}"`);
    res.setHeader("X-Checksum", rows[0].checksum);
    res.send(rows[0].data);
  } catch (e) {
    console.error("[backup/download]", e.message);
    res.status(500).json({ error: "Download failed" });
  }
});

app.delete("/backup/:id", requireLicense, async (req, res) => {
  try {
    const { rows } = await pool.query("DELETE FROM backups WHERE id=$1 AND license_key=$2 RETURNING id", [req.params.id, req.license.license_key]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json({ success: true, deleted_id: parseInt(req.params.id) });
  } catch (e) {
    console.error("[backup/delete]", e.message);
    res.status(500).json({ error: "Delete failed" });
  }
});

// ── Invite email ─────────────────────────────────────────────

app.post("/invite/send", async (req, res) => {
  try {
    const { to, inviteLink, hostName, showName, guestName, personalMessage, roomCode } = req.body || {};

    // Validate recipient address
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))
      return res.status(400).json({ error: "Invalid or missing 'to' email address" });

    // Only allow links pointing at our signaling domain
    if (!inviteLink || !inviteLink.startsWith("https://guests.ether-technologies.com/"))
      return res.status(400).json({ error: "inviteLink must start with https://guests.ether-technologies.com/" });

    const from = process.env.FROM_EMAIL || "Ether <invites@ether-technologies.com>";

    const subject = showName
      ? `${showName} is inviting you to join live`
      : hostName
      ? `${hostName} is inviting you to join live`
      : "You're invited to join live";

    const headerLabel = showName
      ? showName.toUpperCase()
      : hostName
      ? hostName.toUpperCase()
      : "LIVE INVITE";

    const greeting = guestName ? `Hi ${escapeHtml(guestName)},` : "Hi there,";

    const introLine = showName
      ? `<strong>${escapeHtml(showName)}</strong> is inviting you to join a live broadcast.`
      : hostName
      ? `<strong>${escapeHtml(hostName)}</strong> is inviting you to join a live broadcast.`
      : "You're invited to join a live broadcast.";

    const personalBlock = personalMessage
      ? `<div style="margin: 20px 0; padding: 14px 18px; background: #f5f3ff; border-left: 3px solid #6841a0; color: #2d1747; font-size: 15px; line-height: 1.5;">${escapeHtml(personalMessage)}</div>`
      : "";

    const roomCodeBlock = roomCode
      ? `<div style="margin: 28px 0; text-align: center;">
           <div style="font-size: 11px; font-weight: 700; color: #6841a0; letter-spacing: 0.16em; margin-bottom: 8px;">ROOM CODE</div>
           <div style="display: inline-block; padding: 14px 28px; background: #f5f3ff; border: 2px solid #6841a0; color: #2d1747; font-size: 36px; font-weight: 700; letter-spacing: 0.4em; font-family: 'Courier New', monospace;">${escapeHtml(String(roomCode))}</div>
           <div style="font-size: 13px; color: #6b7280; margin-top: 10px;">Enter this code on the join page</div>
         </div>`
      : "";

    const html = `<!DOCTYPE html>
<html>
<body style="margin:0; padding:0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f5f5f5;">
  <div style="max-width: 560px; margin: 40px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
    <div style="background: linear-gradient(180deg, #4a2370 0%, #2d1747 100%); padding: 32px; text-align: center;">
      <div style="color: #ffffff; font-size: 13px; font-weight: 700; letter-spacing: 0.2em; opacity: 0.7; margin-bottom: 6px;">${escapeHtml(headerLabel)}</div>
      <h1 style="margin: 0; color: #ffffff; font-weight: 300; font-size: 26px; letter-spacing: -0.5px;">You're invited to join live</h1>
    </div>
    <div style="padding: 32px;">
      <p style="margin: 0 0 16px 0; color: #2d1747; font-size: 16px;">${greeting}</p>
      <p style="margin: 0 0 16px 0; color: #2d1747; font-size: 16px;">${introLine}</p>
      ${personalBlock}
      <div style="text-align: center; margin: 32px 0 0 0;">
        <a href="${inviteLink}" style="display: inline-block; background: #6841a0; color: #ffffff; padding: 14px 40px; text-decoration: none; border-radius: 4px; font-weight: 700; font-size: 16px;">Join Live</a>
      </div>
      ${roomCodeBlock}
      <p style="margin: 24px 0 0 0; color: #6b7280; font-size: 13px;">Or paste this link into your browser:<br><a href="${inviteLink}" style="color: #6841a0; word-break: break-all;">${inviteLink}</a></p>
      <p style="margin: 28px 0 0 0; color: #9ca3af; font-size: 12px; border-top: 1px solid #e5e7eb; padding-top: 18px; line-height: 1.5;">When you click "Join Live," your browser will ask permission for your camera and microphone.</p>
    </div>
  </div>
</body>
</html>`;

    const { data, error } = await resend.emails.send({ from, to, subject, html });

    if (error) {
      console.error(`[invite/send] Resend error:`, error);
      return res.status(502).json({ error: "Email delivery failed", detail: error.message });
    }

    console.log(`[invite/send] Sent to ${to} (id=${data?.id})`);
    res.json({ ok: true, id: data?.id });
  } catch (e) {
    console.error("[invite/send]", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Sync ──────────────────────────────────────────────────────

const syncRouter = require('./routes/sync')(pool);
app.use('/sync', requireLicense, syncRouter);

// ── Start ─────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`[Ether] API live → port ${PORT}`);
    if (!multer) console.warn("[Ether] multer not installed — backup upload disabled. Run: npm install multer");
  });
}).catch(e => {
  console.error("[Ether] DB init failed:", e.message);
  process.exit(1);
});
