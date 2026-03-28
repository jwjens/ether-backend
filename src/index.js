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

// multer is optional — install with: npm install multer
let multer;
try { multer = require("multer"); } catch { multer = null; }

const app    = express();
const pool   = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const resend = new Resend(process.env.RESEND_API_KEY);

// ── In-memory state ───────────────────────────────────────────
const pendingCmds = [];          // companion → desktop command queue
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
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_licenses_key    ON licenses(license_key)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_licenses_email  ON licenses(email)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_backups_station ON backups(station_id)`);
  await pool.query(`DELETE FROM guest_presence WHERE joined_at < NOW() - INTERVAL '24 hours'`).catch(() => {});
  console.log("[DB] Schema ready");
}

// ── Helpers ───────────────────────────────────────────────────

function generateLicenseKey(plan) {
  const prefix = plan === "station" ? "ETH-STN" : "ETH-PRO";
  const rand   = crypto.randomBytes(12).toString("hex").toUpperCase();
  return `${prefix}-${rand.slice(0,4)}-${rand.slice(4,8)}-${rand.slice(8,12)}`;
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
  const { rows } = await pool.query(
    "SELECT * FROM licenses WHERE license_key=$1 AND active=true", [key]
  ).catch(() => ({ rows: [] }));
  if (!rows.length) return res.status(403).json({ error: "Invalid or inactive license" });
  if (!["pro","station"].includes(rows[0].plan))
    return res.status(403).json({ error: "Pro or Station plan required" });
  req.license = rows[0];
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

// ── Health ────────────────────────────────────────────────────

app.get("/health", (req, res) =>
  res.json({ ok: true, service: "Ether Technologies API", version: "1.5.2", ts: new Date().toISOString() })
);

// ── License validation ────────────────────────────────────────

app.post("/validate", async (req, res) => {
  try {
    const { license_key, email } = req.body;
    if (!license_key?.trim() || !email?.trim())
      return res.status(400).json({ valid: false, error: "Missing license_key or email" });

    const { rows } = await pool.query(
      "SELECT * FROM licenses WHERE license_key=$1 AND email=$2 AND active=true",
      [license_key.trim(), email.trim().toLowerCase()]
    );
    if (!rows.length)
      return res.json({ valid: false, error: "License key not found or does not match this email." });

    await pool.query("UPDATE licenses SET last_validated=NOW() WHERE id=$1", [rows[0].id]);
    res.json({ valid: true, plan: rows[0].plan, email: rows[0].email });
  } catch (e) {
    console.error("[/validate]", e.message);
    res.status(500).json({ valid: false, error: "Server error — please try again." });
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
  await pool.query("INSERT INTO licenses (email,license_key,plan) VALUES ($1,$2,$3)", [email.toLowerCase(), key, plan]);
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
      await pool.query("INSERT INTO licenses (email,license_key,plan,stripe_sub_id) VALUES ($1,$2,$3,$4)", [email, licenseKey, plan, subId]);
      console.log(`[License] Issued: ${licenseKey} → ${email} (${plan})`);
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

app.post("/api/cmd", (req, res) => {
  const { cmd } = req.body;
  if (!cmd) return res.status(400).json({ error: "Missing cmd" });
  pendingCmds.push({ cmd, data: req.body, ts: Math.floor(Date.now() / 1000) });
  if (pendingCmds.length > 20) pendingCmds.splice(0, pendingCmds.length - 20);
  res.json({ ok: true });
});

app.get("/api/pending-cmds", (req, res) => {
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
