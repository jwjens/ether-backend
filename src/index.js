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
 *   FROM_EMAIL    = noreply@ether-technologies.com
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
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
const { validateSlug } = require("./slug");

// JWT signing secret for the Control Center dashboard. MUST be set in production
// (Railway env). Falls back to a per-boot random secret in dev so tokens simply
// invalidate on restart rather than failing hard.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.JWT_SECRET) {
  console.warn("[AUTH] JWT_SECRET not set — using an ephemeral per-boot secret (dashboard sessions reset on restart). Set JWT_SECRET in production.");
}
const JWT_TTL = "12h";                       // access-token lifetime
const PIN_MAX_FAILS = 5;                     // wrong PINs before lockout
const PIN_LOCKOUT_MS = 15 * 60 * 1000;       // lockout duration

// multer is optional — install with: npm install multer
let multer;
try { multer = require("multer"); } catch { multer = null; }

const app    = express();
const pool   = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const resend = new Resend(process.env.RESEND_API_KEY);

// ── R2 client (lazy singleton) ────────────────────────────────
// Backend-signed URL model: customers never hold R2 credentials. Endpoints
// that need R2 (audio sync, DB backups) call getR2Client() and get either
// a configured client or null. Null → respond 503 r2_not_configured so the
// rest of the API keeps working even if R2 env vars are absent (lets the
// backend boot in environments where R2 hasn't been provisioned yet).
let _r2Client = null;
function getR2Client() {
  if (_r2Client) return _r2Client;
  if (!process.env.R2_ACCESS_KEY_ID ||
      !process.env.R2_SECRET_ACCESS_KEY ||
      !process.env.R2_ACCOUNT_ID) {
    return null;
  }
  const { S3Client } = require("@aws-sdk/client-s3");
  _r2Client = new S3Client({
    region: "auto",
    // Recent AWS SDK versions default to adding a CRC32 checksum to PutObject, which
    // breaks presigned PUT URLs: the checksum is computed over an empty body at sign
    // time, then mismatches the real upload → R2 403. Only checksum when required.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    endpoint: (process.env.R2_ENDPOINT || "").trim() ||
              `https://${(process.env.R2_ACCOUNT_ID || "").trim()}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     (process.env.R2_ACCESS_KEY_ID || "").trim(),
      secretAccessKey: (process.env.R2_SECRET_ACCESS_KEY || "").trim(),
    },
  });
  return _r2Client;
}
const R2_BUCKET = (process.env.R2_BUCKET || "ether-audio").trim();

// Public assets bucket — station logos (Phase 2). SEPARATE from the private
// audio/backup buckets because R2 public access is bucket-level: a public
// listener PWA must fetch logos anonymously, so logo_url is a STABLE public URL
// (R2_PUBLIC_BASE_URL), never a presigned/expiring one. If the env is absent,
// logoStorageReady() is false → the logo-upload endpoint returns 503 and the
// rest of the metadata API still works.
const R2_PUBLIC_BUCKET   = process.env.R2_PUBLIC_BUCKET || "";
const R2_PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
function logoStorageReady() { return !!(getR2Client() && R2_PUBLIC_BUCKET && R2_PUBLIC_BASE_URL); }
async function signLogoPutUrl(key, expiresInSeconds = 900) {
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  const { getSignedUrl }     = require("@aws-sdk/s3-request-presigner");
  return getSignedUrl(
    getR2Client(),
    new PutObjectCommand({ Bucket: R2_PUBLIC_BUCKET, Key: key }),
    { expiresIn: expiresInSeconds }
  );
}

// Sanitize a customer-provided file_key. Rejects path traversal, separators,
// null bytes, empty/oversized input. Returns { value } on success, { error }
// on rejection. Centralized so /audio/upload-url and /audio/download-url
// can't drift on validation rules.
function sanitizeFileKey(raw) {
  if (typeof raw !== "string") return { error: "file_key must be a string" };
  const k = raw.trim();
  if (!k)                                  return { error: "file_key is empty" };
  if (k.length > 255)                      return { error: "file_key too long (max 255 chars)" };
  if (k.includes("/") || k.includes("\\")) return { error: "file_key must be a basename (no path separators)" };
  if (k.includes(".."))                    return { error: 'file_key must not contain ".."' };
  if (k.includes("\0"))                    return { error: "file_key contains null byte" };
  return { value: k };
}

// Sanitize a client-supplied backup timestamp. Matches the filename-safe ISO
// shape used by cloud-backup.js (after Phase 1.3f): YYYY-MM-DDTHH-MM-SS[Z].
// Hyphens (not colons) in the time portion so the key is legal as a Windows
// filename when the customer downloads a backup. The regex implicitly blocks
// path separators, traversal, and null bytes — no character outside the
// digit/hyphen/T/Z set is permitted.
function sanitizeBackupTimestamp(raw) {
  if (typeof raw !== "string") return { error: "timestamp must be a string" };
  const t = raw.trim();
  if (!t) return { error: "timestamp is empty" };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z?$/.test(t)) {
    return { error: "timestamp must match YYYY-MM-DDTHH-MM-SS[Z]" };
  }
  return { value: t };
}

// Sign a short-lived PutObject URL scoped to the given R2 key. Caller must
// have already verified getR2Client() is non-null; this helper does not
// re-check (keeps the 503 vs 500 split cleanly at the route layer).
// Throws on SDK signing failure — caller wraps in try/catch.
async function signR2PutUrl(key, expiresInSeconds = 900) {
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  const { getSignedUrl }     = require("@aws-sdk/s3-request-presigner");
  return getSignedUrl(
    getR2Client(),
    new PutObjectCommand({ Bucket: R2_BUCKET, Key: key }),
    { expiresIn: expiresInSeconds }
  );
}

// Sign a short-lived GetObject URL. Same caller contract as signR2PutUrl —
// caller null-checks getR2Client() first; this helper throws on SDK failure.
// No HeadObject check here: if the key doesn't exist, the signed URL is
// returned successfully and the customer gets R2's own 404 on the GET.
async function signR2GetUrl(key, expiresInSeconds = 900) {
  const { GetObjectCommand } = require("@aws-sdk/client-s3");
  const { getSignedUrl }     = require("@aws-sdk/s3-request-presigner");
  return getSignedUrl(
    getR2Client(),
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
    { expiresIn: expiresInSeconds }
  );
}

// List every R2 object key under a given prefix. Loops via ContinuationToken
// until exhausted (ListObjectsV2 returns up to 1000 keys per page). Caller
// must null-check getR2Client() first; throws on SDK failure. Returns array
// of FULL keys including the prefix — caller strips if needed.
//
// Practical ceiling: ~10k keys before this gets expensive (10 round-trips,
// ~300KB JSON response). Real broadcast libraries are typically 5–6k songs.
// If a real customer crosses 10k, switch to client-side pagination with a
// cursor parameter. Tracked as a future concern, not blocking today.
async function listR2ObjectsForPrefix(prefix) {
  const { ListObjectsV2Command } = require("@aws-sdk/client-s3");
  const client = getR2Client();
  const keys = [];
  let continuationToken;
  do {
    const resp = await client.send(new ListObjectsV2Command({
      Bucket:            R2_BUCKET,
      Prefix:            prefix,
      ContinuationToken: continuationToken,
    }));
    for (const obj of resp.Contents || []) {
      if (obj.Key) keys.push(obj.Key);
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

// ── In-memory state ───────────────────────────────────────────
const pendingCmds = new Map();   // licenseId(string) → array of queued cmds (per-license; drained on cmd-stream connect)
const sseClients  = new Map();   // licenseId(string) → Set<res> for cmd-stream subscribers
const streamClients = new Map(); // slug → Set<res> for public listener-page SSE (Phase 3)
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

// Per-plan machine activation limits — used by legacy /validate.
// A single license can be active on this many machines simultaneously.
// Users can deactivate machines to free up slots.
const PLAN_MACHINE_LIMITS = { free: 1, pro: 2, station: 5 };

// Seat limit for the onboarding flow (onboarding-spec-v1.md "Core concepts").
// Uniform across tiers — Stripe is the gate for whether a license exists at
// all; the seat cap is independent of plan. The /account/* endpoints use this
// constant rather than PLAN_MACHINE_LIMITS so the onboarding contract is
// stable even if plan-tier seat math changes later.
const SEATS_MAX = 5;

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

  // Customer accounts (email + password) — the simplified customer-facing identity that will
  // replace license keys in the apps. Free signup captures the email + starts a 15-day trial;
  // a paid Stripe subscription links license_key_id. The license stays the internal entitlement.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id              SERIAL PRIMARY KEY,
      name            TEXT,
      email           TEXT NOT NULL UNIQUE,
      password_hash   TEXT NOT NULL,
      email_verified  BOOLEAN NOT NULL DEFAULT false,
      verify_token    TEXT,
      reset_token     TEXT,
      reset_expires   TIMESTAMPTZ,
      trial_ends_at   TIMESTAMPTZ,
      license_key_id  INTEGER REFERENCES licenses(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at   TIMESTAMPTZ
    )
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT`);
  // Email marketing opt-out (CAN-SPAM). Each user gets a stable, opaque unsubscribe token.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_opt_out BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS unsubscribe_token TEXT`);
  await pool.query(`UPDATE users SET unsubscribe_token = md5(random()::text || clock_timestamp()::text || id::text) WHERE unsubscribe_token IS NULL`);
  await pool.query(`DELETE FROM guest_presence WHERE joined_at < NOW() - INTERVAL '24 hours'`).catch(() => {});

  // Schema migrations: original DB used status TEXT and lacked active/last_validated.
  // ADD COLUMN IF NOT EXISTS backfills existing rows with the declared DEFAULT.
  await pool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`);
  await pool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS last_validated TIMESTAMPTZ`);
  // Trial licenses expire (expires_at = the user's trial_ends_at); paid licenses leave it NULL = perpetual.
  await pool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
  // bcrypt key storage (key_prefix + key_hash) — queried by lookupLicense / minted by /admin/issue,
  // /api/platform/licenses and the Stripe webhook, but never actually created on the table before.
  await pool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS key_prefix TEXT`);
  await pool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS key_hash   TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_licenses_key_prefix ON licenses(key_prefix)`);
  // Drop the stale plan CHECK constraint — it predates the newer tiers (pro_lifetime,
  // station_lifetime, operator) and rejected them. Plan is validated in code against VALID_PLANS.
  await pool.query(`ALTER TABLE licenses DROP CONSTRAINT IF EXISTS licenses_plan_check`);
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

  // Sync schema migrations — add columns that sync.js INSERT requires but
  // were absent from the original CREATE TABLE above (table already exists
  // on Railway, so CREATE TABLE IF NOT EXISTS is a no-op there).
  await pool.query(`ALTER TABLE mutations ADD COLUMN IF NOT EXISTS operator_id    TEXT`);
  await pool.query(`ALTER TABLE mutations ADD COLUMN IF NOT EXISTS license_key_id INTEGER REFERENCES licenses(id)`);
  // Backing index for ON CONFLICT (license_key_id, id) DO NOTHING in sync.js.
  // CREATE UNIQUE INDEX IF NOT EXISTS is the idempotent form; no equivalent
  // "ADD CONSTRAINT IF NOT EXISTS" exists in Postgres for unique constraints.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mutations_lkid_id ON mutations(license_key_id, id)`);

  // ── Onboarding schema (onboarding-spec-v1.md) ──────────────────────────────
  // Flatter than the spec's accounts/stations/seats split: account info collapses
  // into licenses, seat info collapses into license_activations, stations stays.
  await pool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS account_name TEXT`);
  await pool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stations (
      id              SERIAL PRIMARY KEY,
      uuid            TEXT NOT NULL UNIQUE,
      license_key_id  INTEGER NOT NULL REFERENCES licenses(id),
      name            TEXT NOT NULL,
      nickname        TEXT,
      frequency       TEXT,
      call_letters    TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stations_license ON stations(license_key_id)`);

  await pool.query(`ALTER TABLE license_activations ADD COLUMN IF NOT EXISTS station_uuid    TEXT REFERENCES stations(uuid) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE license_activations ADD COLUMN IF NOT EXISTS deauthorized_at TIMESTAMPTZ`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activations_station ON license_activations(station_uuid)`);
  // Partial index — supports "count active seats" in /account/connect (deauthorized_at IS NULL).
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activations_active ON license_activations(license_key) WHERE deauthorized_at IS NULL`);

  // ── Listener Platform / Station Metadata service (Phase 1) ─────────────────
  // All additive. station_now_playing is a live cache (upsert per report);
  // station_metadata is the opt-in public-page branding (lazy — no row until a
  // customer configures a page); station_slug_history backs slug-rename redirects.
  // `slug TEXT UNIQUE` permits many NULLs (unconfigured) + one owner per non-null.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS station_now_playing (
      station_uuid   TEXT PRIMARY KEY REFERENCES stations(uuid) ON DELETE CASCADE,
      playing        BOOLEAN NOT NULL DEFAULT false,
      title          TEXT,
      artist         TEXT,
      deck           TEXT,
      started_at     TIMESTAMPTZ,
      position_sec   INTEGER,
      duration_sec   INTEGER,
      queue          JSONB,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // art_url: public R2 URL of the on-air track's embedded cover art (primary artwork
  // for the listener page; iTunes is the listener's fallback). Additive.
  await pool.query(`ALTER TABLE station_now_playing ADD COLUMN IF NOT EXISTS art_url TEXT`);
  // decks: full per-physical-deck snapshot {A,B,C} (title/artist/status/positionSec/durationSec)
  // so consumers (dashboard) can show each song on its REAL deck instead of normalizing the
  // on-air track to "Deck A". JSONB → no integer-strictness issue with fractional positions.
  await pool.query(`ALTER TABLE station_now_playing ADD COLUMN IF NOT EXISTS decks JSONB`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS station_metadata (
      station_uuid    TEXT PRIMARY KEY REFERENCES stations(uuid) ON DELETE CASCADE,
      slug            TEXT UNIQUE,
      display_name    TEXT,
      logo_url        TEXT,
      color_primary   TEXT,
      color_secondary TEXT,
      description     TEXT,
      socials         JSONB,
      public_enabled  BOOLEAN NOT NULL DEFAULT false,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS station_slug_history (
      old_slug      TEXT PRIMARY KEY,
      station_uuid  TEXT NOT NULL REFERENCES stations(uuid) ON DELETE CASCADE,
      changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Phase 4: per-station Icecast stream URL for the listener PWA. ALTER (not a
  // CREATE edit) because station_metadata already exists on Railway — CREATE
  // TABLE IF NOT EXISTS is a no-op there and would never add the column.
  await pool.query(`ALTER TABLE station_metadata ADD COLUMN IF NOT EXISTS stream_url TEXT`);
  // Ethercast directory category — 'music' | 'talk' | 'sports' | null. Drives the
  // hub's Music/Talk/Sports tabs. Operator sets it in the station settings.
  await pool.query(`ALTER TABLE station_metadata ADD COLUMN IF NOT EXISTS category TEXT`);

  // ── Control Center / Multi-Tenant dashboard (Roadmap Item 5, Phase 1) ──────
  // Per-LICENSE human operators that can sign into app.ether-technologies.com.
  // Distinct from license_activations (devices) and from the desktop's local
  // per-install `users` table. role is 'admin' | 'user'. pin_hash uses the same
  // "salt:sha256(salt+pin)" scheme as the desktop so install-pushed PINs and
  // web-created PINs verify identically. Lockout columns guard 4-digit brute force.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_users (
      id              SERIAL PRIMARY KEY,
      license_key_id  INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
      username        TEXT NOT NULL,
      display_name    TEXT,
      role            TEXT NOT NULL DEFAULT 'user',
      pin_hash        TEXT NOT NULL,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at      TIMESTAMPTZ
    )
  `);
  // One live username per license (case-insensitive); deleted rows don't block reuse.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_account_users_live
    ON account_users (license_key_id, lower(username)) WHERE deleted_at IS NULL
  `);
  // origin: 'dashboard' (web bootstrap / Users tab) vs 'install' (mirrored up from a
  // desktop install's local console users). The install push only ever touches its
  // own 'install' rows, so it can never clobber a dashboard-managed user.
  await pool.query(`ALTER TABLE account_users ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'dashboard'`);

  // ── Control Center data mirror (Roadmap Item 5, Phase 2) ───────────────────
  // Generic per-station row mirror so the dashboard can VIEW install-owned data
  // (categories, clocks, library, …) without the full sync engine. The desktop
  // pushes rows per table (same pattern as now-playing/users); the dashboard reads
  // them; edits go back via the command bus and the install re-pushes the result.
  // One table for every domain — payload is the row as JSON; deleted_at tombstones.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS station_cc_data (
      station_uuid TEXT NOT NULL REFERENCES stations(uuid) ON DELETE CASCADE,
      table_name   TEXT NOT NULL,
      row_uuid     TEXT NOT NULL,
      payload      JSONB NOT NULL,
      deleted_at   TIMESTAMPTZ,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (station_uuid, table_name, row_uuid)
    )
  `);

  // Append-only play history for cross-install analytics (Phase 3a). The install pushes
  // new play_log rows incrementally; rows are never updated (ON CONFLICT DO NOTHING).
  // Distinct from station_cc_data (which tombstones) because history only grows.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS station_play_history (
      station_uuid  TEXT NOT NULL REFERENCES stations(uuid) ON DELETE CASCADE,
      row_uuid      TEXT NOT NULL,
      title         TEXT,
      artist        TEXT,
      category_code TEXT,
      show_name     TEXT,
      duration_ms   INTEGER,
      played_at     TIMESTAMPTZ,
      file_path     TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (station_uuid, row_uuid)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_play_history_station_time ON station_play_history (station_uuid, played_at DESC)`);
  // file_path (the aired audio) is the affidavit join key — add to pre-existing deployments.
  await pool.query(`ALTER TABLE station_play_history ADD COLUMN IF NOT EXISTS file_path TEXT`);

  // Periodic snapshots of concurrent listener count per station (Phase 3b) for peak /
  // trend. Live "now" + by-country come from in-memory SSE connections; this is history.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS station_listener_samples (
      station_uuid TEXT NOT NULL REFERENCES stations(uuid) ON DELETE CASCADE,
      ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      count        INTEGER NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_listener_samples ON station_listener_samples (station_uuid, ts DESC)`);

  // Phase 3 — true stream listener samples polled from each station's Icecast (status-json.xsl),
  // sampled every 60s. Counts EVERY listener (web player + external apps), unlike the SSE samples
  // above. Integrating these (Σ listeners × 1 min) gives Aggregate Tuning Hours (ATH) for royalty
  // reporting — the defensible all-listener number.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS station_stream_samples (
      station_uuid TEXT NOT NULL REFERENCES stations(uuid) ON DELETE CASCADE,
      ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      listeners    INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stream_samples ON station_stream_samples (station_uuid, ts DESC)`);

  // Per-session listening log (Phase 3c) — one row per completed listen, written on SSE disconnect.
  // Powers the audience report: total sessions, unique listeners (anonymous lid), total listening
  // hours (TLH), avg session length, tune-in-by-hour, and by country/state/city over any range.
  // No IP / PII — only Cloudflare's country/region/city + a random browser-generated id.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS listener_sessions (
      station_uuid TEXT NOT NULL REFERENCES stations(uuid) ON DELETE CASCADE,
      started_at   TIMESTAMPTZ NOT NULL,
      ended_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_sec INTEGER NOT NULL DEFAULT 0,
      cc           TEXT,
      region       TEXT,
      city         TEXT,
      lid          TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_listener_sessions ON listener_sessions (station_uuid, started_at DESC)`);

  console.log("[DB] Schema ready");
}

// ── Helpers ───────────────────────────────────────────────────

// Canonical PlanTier values — must match src/hooks/usePlan.tsx in openair.
// Used by /admin/issue to reject typos/invalid plans (EB4). Without this gate
// an admin could write any string to licenses.plan; the renderer's TIER_RANK
// lookup returns undefined for unknown values, so requirePlan() fails every
// check — customer ends up worse than free with a fully-issued license.
const VALID_PLANS = new Set([
  "free", "pro", "pro_lifetime", "station", "station_lifetime", "operator",
]);

// Stripe priceId → PlanTier lookup. Used by /webhook/stripe to determine
// which plan a new license should be issued at (EB3). Replaces the prior
// silent fallback (`priceId === PRICE_STATION ? "station" : "pro"`) which
// would map ANY unknown priceId — including a new Stripe product added
// without updating the webhook — to "pro" tier. Now unknown priceIds are
// logged loudly and the webhook acks without issuing a license; operator
// must intervene via /admin/issue.
//
// .filter drops unset env vars so two unconfigured products don't collide
// on a shared "" key (Object.fromEntries would otherwise produce {"": "..."}).
//
// Extending: add a row when a new Stripe product is created. pro_lifetime,
// station_lifetime, operator have no Stripe products today — they're
// admin-issued only.
const PLAN_BY_PRICE_ID = Object.fromEntries(
  [
    [process.env.PRICE_PRO,     "pro"],
    [process.env.PRICE_STATION, "station"],
  ].filter(([id]) => !!id)
);

// Per-plan station limits enforced server-side in /account/add-station (EB2).
// Network tier's differentiator is audio-sync features, not station count —
// hence the uniform 5 across pro/pro_lifetime/station/station_lifetime.
// operator → -1 sentinel for unlimited; the handler short-circuits before
// the COUNT query when it sees -1. free → 1 is defense-in-depth alongside
// /account/create's onboarded_at gate (which already structurally limits
// free licenses to 1 station, but if that gate is ever bypassed this
// catches it on the add-station path).
const PLAN_STATION_LIMITS = {
  free:             1,
  pro:              5,
  pro_lifetime:     5,
  station:          5,
  station_lifetime: 5,
  operator:        -1,
};

function generateLicenseKey(plan) {
  const prefix = (plan === "station" || plan === "station_lifetime") ? "ETH-STN"
               : plan === "operator" ? "ETH-ENT"
               : "ETH-PRO";   // pro / pro_lifetime / free
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

// ── Email theme — light card, Ether purple (#8868D8) accent, CAN-SPAM footer ──
const COMPANY_NAME = "Ether Technologies";
const SUPPORT_EMAIL = "support@ether-technologies.com";
// Physical postal address for CAN-SPAM. Set COMPANY_ADDRESS in Railway once a real
// mailing address exists; required before sending any marketing (non-transactional) email.
const COMPANY_ADDRESS = process.env.COMPANY_ADDRESS || "Mailing address available on request";
const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || "https://ether-backend-production.up.railway.app").replace(/\/$/, "");

function emailButton(button) {
  if (!button) return "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 6px"><tr><td style="border-radius:8px;background:#8868D8">
      <a href="${button.url}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${button.label}</a>
    </td></tr></table>`;
}

// Wrap body HTML in the standard light card + footer. `unsubUrl` (when present) adds the
// CAN-SPAM unsubscribe link; transactional mail (verify / reset / receipts) passes none.
function emailShell({ heading, bodyHtml, button, unsubUrl }) {
  const year = new Date().getFullYear();
  const sans = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f7">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${heading}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #ececf1;border-radius:14px">
        <tr><td style="padding:32px 32px 30px;font-family:${sans}">
          <div style="font-size:19px;font-weight:800;color:#8868D8;letter-spacing:-0.02em;margin-bottom:26px">&#x2B22; Ether</div>
          <h1 style="font-size:20px;font-weight:700;color:#18181b;margin:0 0 14px;letter-spacing:-0.01em">${heading}</h1>
          <div style="font-size:15px;line-height:1.65;color:#52525b">${bodyHtml}</div>
          ${emailButton(button)}
        </td></tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px">
        <tr><td style="padding:20px 32px;font-family:${sans};font-size:12px;line-height:1.7;color:#a1a1aa">
          <div style="color:#71717a;font-weight:600;margin-bottom:3px">${COMPANY_NAME}</div>
          ${COMPANY_ADDRESS} &middot; <a href="mailto:${SUPPORT_EMAIL}" style="color:#8868D8;text-decoration:none">${SUPPORT_EMAIL}</a>${unsubUrl ? ` &middot; <a href="${unsubUrl}" style="color:#a1a1aa;text-decoration:underline">Unsubscribe</a>` : ""}
          <div style="margin-top:8px;color:#c4c4cc">&copy; ${year} ${COMPANY_NAME}. You're receiving this because you have an Ether account.</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

async function sendLicenseEmail(email, licenseKey, plan) {
  const label = plan === "station" ? "Network" : "Studio";
  const price = plan === "station" ? "$79/mo" : "$19/mo";
  const from  = process.env.FROM_EMAIL || "noreply@ether-technologies.com";
  const bodyHtml = `
    <p style="margin:0 0 18px">Thanks for subscribing to <strong style="color:#18181b">Ether ${label}</strong> (${price}). Save this email — you'll need the key if you ever reinstall.</p>
    <div style="background:#f7f6fc;border:1px solid #e6e1f7;border-radius:10px;padding:18px;text-align:center;margin:0 0 20px">
      <div style="font-size:10px;color:#8a8a96;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px">License Key</div>
      <div style="font-family:'Courier New',monospace;font-size:18px;font-weight:800;color:#6040C0;letter-spacing:2px">${escapeHtml(licenseKey)}</div>
    </div>
    <div style="font-size:13px;font-weight:700;color:#18181b;margin:0 0 8px">How to activate</div>
    <ol style="color:#52525b;font-size:13px;line-height:2;padding-left:20px;margin:0">
      <li>Open <strong style="color:#18181b">Ether</strong> on your computer</li>
      <li>Click the <strong style="color:#18181b">Studio</strong> button in the top toolbar</li>
      <li>Click <strong style="color:#18181b">Enter License Key</strong></li>
      <li>Enter your email and the key above</li>
    </ol>`;
  const html = emailShell({ heading: `Your ${label} license key`, bodyHtml, button: null, unsubUrl: null });
  const { error } = await resend.emails.send({ from, to: email, subject: `Your Ether ${label} License Key`, html });
  if (error) throw new Error(JSON.stringify(error));
}

// ── Auth middleware ───────────────────────────────────────────

// Two-path license lookup per B-12 — shared by requireLicense and cmd-stream.
// Returns the matching license row or null; never throws (errors become null).
//   New keys (bcrypt):     key_prefix match + bcrypt.compare(rawKey, key_hash)
//   Old keys (plaintext):  license_key direct string match
// Any future endpoint needing license validation should call this rather than
// duplicating the query logic.
async function lookupLicense(rawKey) {
  const prefix = rawKey.slice(0, 12);
  const { rows } = await pool.query(
    `SELECT * FROM licenses
     WHERE (key_prefix = $1 OR license_key = $2) AND active = true`,
    [prefix, rawKey]
  ).catch(() => ({ rows: [] }));
  for (const row of rows) {
    // Expired trial license → treat as no match (paid licenses have expires_at = NULL, always pass).
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) continue;
    if (row.key_hash != null) {
      if (await bcrypt.compare(rawKey, row.key_hash)) return row;
    } else if (rawKey === row.license_key) {
      return row;
    }
  }
  return null;
}

async function requireLicense(req, res, next) {
  const key = req.headers["x-license-key"];
  if (!key) return res.status(401).json({ error: "Missing x-license-key header" });
  const license = await lookupLicense(key).catch(() => null);
  if (!license) return res.status(401).json({ error: "invalid_license_key" });
  if (!["pro", "station"].includes(license.plan))
    return res.status(403).json({ error: "Studio or Network plan required" });
  req.license = license;
  next();
}

function requireAdmin(req, res, next) {
  const s = req.headers["x-admin-secret"] || req.query.secret;
  if (s !== process.env.ADMIN_SECRET) return res.status(403).json({ error: "Forbidden" });
  next();
}

// ── Control Center auth (Roadmap Item 5, Phase 1) ─────────────────────────────
// PIN hashing mirrors the desktop scheme (salt:sha256) so install-pushed and
// web-created PINs verify identically.
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.createHash("sha256").update(salt + pin).digest("hex");
}
function verifyPin(pin, stored) {
  if (!stored) return false;
  if (!stored.includes(":")) return pin === stored;        // legacy plaintext
  const [salt, hash] = stored.split(":");
  return crypto.createHash("sha256").update(salt + pin).digest("hex") === hash;
}
function isValidPin(pin)    { return typeof pin === "string" && /^\d{4}$/.test(pin); }
function normUsername(u)    { return typeof u === "string" ? u.trim() : ""; }
function isValidUsername(u) { return /^[A-Za-z0-9 ._-]{1,32}$/.test(u); }

function signAccountToken(user) {
  return jwt.sign(
    { uid: user.id, lk: user.license_key_id, role: user.role, username: user.username },
    JWT_SECRET, { expiresIn: JWT_TTL }
  );
}
function requireAuth(req, res, next) {
  const h = req.headers["authorization"] || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing_token" });
  try { req.auth = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: "invalid_token" }); }
}
function requireAuthAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.auth.role !== "admin") return res.status(403).json({ error: "admin_required" });
    next();
  });
}

// ── Platform owner (Ether Technologies) ───────────────────────────────────
// A single platform-operator login that sees ALL accounts/stations — for the company's
// own cross-account analytics + BMI/ASCAP/SoundExchange listening-hour reporting. Gated by
// a shared secret in ETHER_PLATFORM_SECRET (set in Railway env, never in code); exchanged
// for a JWT carrying { platform:true }. requirePlatform admits only that token.
const PLATFORM_SECRET = process.env.ETHER_PLATFORM_SECRET || "";
function requirePlatform(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.auth.platform) return res.status(403).json({ error: "platform_required" });
    next();
  });
}
// An account token must OWN the station; a platform token may read ANY station's reports.
async function stationReadable(req, stationUuid) {
  if (req.auth && req.auth.platform) {
    const { rows } = await pool.query(`SELECT 1 FROM stations WHERE uuid = $1`, [stationUuid]);
    return rows.length > 0;
  }
  const { rows } = await pool.query(`SELECT 1 FROM stations WHERE uuid = $1 AND license_key_id = $2`, [stationUuid, req.auth.lk]);
  return rows.length > 0;
}

app.post("/api/platform/login", (req, res) => {
  if (!PLATFORM_SECRET) return res.status(503).json({ error: "platform_not_configured" });
  const secret = String(req.body?.secret || "");
  const a = Buffer.from(secret), b = Buffer.from(PLATFORM_SECRET);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "invalid_secret" });
  const token = jwt.sign({ platform: true }, JWT_SECRET, { expiresIn: JWT_TTL });
  res.json({ token });
});

// Platform-gated config diagnostic. Price IDs aren't secrets; the secret key is never returned.
// Asks Stripe (with the configured key) which ACCOUNT it belongs to + lists the real prices it
// can see, so we can see exactly why a checkout price isn't found.
app.get("/api/platform/diag", requirePlatform, async (_req, res) => {
  const k = process.env.STRIPE_SECRET_KEY || "";
  const out = {
    stripe_key_suffix: k ? k.slice(-4) : null,
    stripe_key_mode: k.startsWith("sk_live") ? "live" : k.startsWith("sk_test") ? "test" : "unknown",
    price_pro_env: process.env.PRICE_PRO || null,
    price_station_env: process.env.PRICE_STATION || null,
    stripe_webhook_secret_set: !!process.env.STRIPE_WEBHOOK_SECRET,
    account_app_url: process.env.ACCOUNT_APP_URL || null,
  };
  if (k) {
    try {
      const stripe = require("stripe")(k);
      const acct = await stripe.accounts.retrieve();
      out.key_belongs_to_account = acct.id;
      const prices = await stripe.prices.list({ limit: 20, expand: ["data.product"] });
      out.prices_visible_to_key = prices.data.map((p) => ({
        id: p.id, amount: p.unit_amount, interval: p.recurring?.interval || "one-time",
        product: (p.product && p.product.name) || String(p.product), active: p.active,
      }));
      out.price_pro_found = prices.data.some((p) => p.id === process.env.PRICE_PRO);
      out.price_station_found = prices.data.some((p) => p.id === process.env.PRICE_STATION);
    } catch (e) { out.stripe_error = e.message; }
  }
  res.json(out);
});

// One-click "download the latest Ether installer" — resolves the newest GitHub release asset for
// the OS and 302-redirects to it, so the link is always current (filenames are versioned).
// os = mac | windows | linux. Cached 5 min to respect GitHub's unauthenticated rate limit.
let _relCache = { at: 0, assets: null };
async function latestEtherAssets() {
  if (_relCache.assets && Date.now() - _relCache.at < 300000) return _relCache.assets;
  const r = await fetch("https://api.github.com/repos/jwjens/ether/releases/latest", { headers: { "User-Agent": "ether-backend", "Accept": "application/vnd.github+json" } });
  if (!r.ok) throw new Error("github " + r.status);
  const j = await r.json();
  _relCache = { at: Date.now(), assets: j.assets || [] };
  return _relCache.assets;
}
app.get("/download/:os", async (req, res) => {
  try {
    const os = String(req.params.os || "").toLowerCase();
    const a = (await latestEtherAssets()).filter((x) => !x.name.endsWith(".blockmap"));
    let pick;
    if (os === "windows" || os === "win") pick = a.find((x) => x.name.endsWith(".exe"));
    else if (os === "mac" || os === "macos") pick = a.find((x) => x.name.endsWith(".dmg") && !x.name.includes("arm64")) || a.find((x) => x.name.endsWith(".dmg"));
    else if (os === "linux") pick = a.find((x) => x.name.endsWith(".AppImage"));
    if (!pick) return res.status(404).json({ error: "no_installer_for_os" });
    res.redirect(302, pick.browser_download_url);
  } catch (e) { console.error("[download]", e.message); res.status(502).json({ error: "download_unavailable" }); }
});

// All accounts (= licenses) with their station counts — the top-level folder list.
app.get("/api/platform/accounts", requirePlatform, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.email, l.plan, l.active, l.created_at, COUNT(s.uuid)::int AS stations
         FROM licenses l
         LEFT JOIN stations s ON s.license_key_id = l.id
        GROUP BY l.id
        ORDER BY l.email`
    );
    res.json({ accounts: rows });
  } catch (e) { console.error("[platform/accounts]", e.message); res.status(500).json({ error: "server_error" }); }
});

// Stations under one account.
app.get("/api/platform/accounts/:id/stations", requirePlatform, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: "bad_id" });
    const acct = (await pool.query(`SELECT id, email, plan, active, created_at FROM licenses WHERE id = $1`, [id])).rows[0];
    if (!acct) return res.status(404).json({ error: "account_not_found" });
    const { rows } = await pool.query(
      `SELECT s.uuid, s.name, s.created_at, m.slug, m.display_name, m.public_enabled
         FROM stations s
         LEFT JOIN station_metadata m ON m.station_uuid = s.uuid
        WHERE s.license_key_id = $1
        ORDER BY COALESCE(m.display_name, s.name)`,
      [id]
    );
    res.json({ account: acct, stations: rows });
  } catch (e) { console.error("[platform/stations]", e.message); res.status(500).json({ error: "server_error" }); }
});

// Delete an account (license) and everything under it — platform-owner only. Transactional, in
// FK-safe order: station_* data cascades when its station is deleted; stations + mutations reference
// licenses WITHOUT cascade so they're removed first; account_users cascades on the license delete.
app.delete("/api/platform/accounts/:id", requirePlatform, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "bad_id" });
  const client = await pool.connect();
  try {
    const { rows: lic } = await client.query(`SELECT license_key, email FROM licenses WHERE id = $1`, [id]);
    if (!lic.length) { client.release(); return res.status(404).json({ error: "account_not_found" }); }
    const key = lic[0].license_key;
    await client.query("BEGIN");
    await client.query(`DELETE FROM mutations WHERE license_key_id = $1`, [id]);   // FK, no cascade
    await client.query(`DELETE FROM stations  WHERE license_key_id = $1`, [id]);   // cascades all station_* data
    await client.query(`DELETE FROM users     WHERE license_key_id = $1`, [id]);   // account holder (signup) — FK, no cascade; nothing references users
    if (key) {
      await client.query(`DELETE FROM license_activations WHERE license_key = $1`, [key]);
      await client.query(`DELETE FROM backups            WHERE license_key = $1`, [key]);
    }
    const del = await client.query(`DELETE FROM licenses WHERE id = $1`, [id]);    // cascades account_users
    await client.query("COMMIT");
    res.json({ ok: true, deleted: del.rowCount, email: lic[0].email });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[platform/delete-account]", e.message);
    res.status(500).json({ error: "server_error", detail: e.message });
  } finally { client.release(); }
});

// Delete a single station and everything under it — platform-owner only. The stations row delete
// cascades all station_* data via FK ON DELETE CASCADE; we also purge that station's mutation-log
// rows so a stale desktop re-sync can't resurrect it.
app.delete("/api/platform/stations/:uuid", requirePlatform, async (req, res) => {
  const uuid = String(req.params.uuid || "");
  if (!uuid) return res.status(400).json({ error: "bad_uuid" });
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT name FROM stations WHERE uuid = $1`, [uuid]);
    if (!rows.length) { client.release(); return res.status(404).json({ error: "station_not_found" }); }
    await client.query("BEGIN");
    await client.query(`DELETE FROM mutations WHERE station_id = $1 OR (table_name = 'stations' AND row_id = $1)`, [uuid]);
    const del = await client.query(`DELETE FROM stations WHERE uuid = $1`, [uuid]); // cascades station_* data
    await client.query("COMMIT");
    res.json({ ok: true, deleted: del.rowCount, name: rows[0].name });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[platform/delete-station]", e.message);
    res.status(500).json({ error: "server_error", detail: e.message });
  } finally { client.release(); }
});

// ── License management (platform owner) — mint comp/promo keys + assign a tier, no payment ──
const LICENSE_TIERS = ["free", "pro", "pro_lifetime", "station", "station_lifetime", "operator"];
app.get("/api/platform/licenses", requirePlatform, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.email, l.plan, l.active, l.created_at, l.key_prefix, l.last_validated,
              (SELECT COUNT(*)::int FROM stations s WHERE s.license_key_id = l.id) AS stations,
              (SELECT COUNT(*)::int FROM license_activations a
                 WHERE (a.license_key = l.license_key OR a.license_key = 'lic-' || l.id) AND a.deauthorized_at IS NULL) AS activations
         FROM licenses l ORDER BY l.created_at DESC`
    );
    res.json({ tiers: LICENSE_TIERS, licenses: rows });
  } catch (e) { console.error("[platform/licenses]", e.message); res.status(500).json({ error: "server_error" }); }
});

app.post("/api/platform/licenses", requirePlatform, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const plan = String(req.body?.plan || "");
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "invalid_email" });
    if (!VALID_PLANS.has(plan)) return res.status(400).json({ error: "invalid_plan", detail: `plan must be one of: ${[...VALID_PLANS].join(", ")}` });
    const key = generateLicenseKey(plan);
    const { rows } = await pool.query(
      `INSERT INTO licenses (email, plan, key_prefix, key_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
      [email, plan, key.slice(0, 12), await bcrypt.hash(key, 12)]
    );
    if (req.body?.send_email) { try { await sendLicenseEmail(email, key, plan); } catch (e) { console.error("[Email]", e.message); } }
    res.json({ ok: true, id: rows[0].id, license_key: key, plan, email });
  } catch (e) { console.error("[platform/licenses:create]", e.message); res.status(500).json({ error: "server_error", detail: e.message }); }
});

// Change a license's tier in place — the existing key keeps working; the desktop picks up the new
// plan on its next /validate (relaunch). Lets you fix a wrong tier without reissuing a key.
app.patch("/api/platform/licenses/:id", requirePlatform, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const plan = String(req.body?.plan || "");
    if (!id) return res.status(400).json({ error: "bad_id" });
    if (!VALID_PLANS.has(plan)) return res.status(400).json({ error: "invalid_plan" });
    const r = await pool.query(`UPDATE licenses SET plan = $1 WHERE id = $2 RETURNING id`, [plan, id]);
    if (!r.rowCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true, id, plan });
  } catch (e) { console.error("[platform/licenses:update]", e.message); res.status(500).json({ error: "server_error" }); }
});

// Network analytics rollup across ALL stations for a custom date range (the report you submit
// to ASCAP / BMI / SoundExchange — it's just the aggregated analytics). from/to = YYYY-MM-DD,
// inclusive of the `to` day. Listening hours (ATH) from listener_sessions; performances (plays)
// from station_play_history.
function validRange(req) {
  const from = String(req.query.from || ""), to = String(req.query.to || "");
  const re = /^\d{4}-\d{2}-\d{2}$/;
  return re.test(from) && re.test(to) ? { from, to } : null;
}

// Current listener count on a station's Icecast mount, via the public status-json.xsl. Returns the
// integer count, or null if unreachable / unparseable (caller skips). 5s timeout; no creds needed.
async function icecastListeners(streamUrl) {
  try {
    const u = new URL(streamUrl);
    const mount = u.pathname;
    const statusUrl = `${u.protocol}//${u.host}/status-json.xsl`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    let res;
    try { res = await fetch(statusUrl, { signal: ctrl.signal }); } finally { clearTimeout(timer); }
    if (!res || !res.ok) return null;
    const j = await res.json();
    let sources = j && j.icestats && j.icestats.source;
    if (!sources) return null;
    if (!Array.isArray(sources)) sources = [sources];
    const match = sources.find((s) => {
      try { return new URL(s.listenurl).pathname === mount; } catch { return String(s.listenurl || "").endsWith(mount); }
    }) || (sources.length === 1 ? sources[0] : null);
    if (!match) return null;
    const n = Number(match.listeners);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}
app.get("/api/platform/rollup", requirePlatform, async (req, res) => {
  try {
    const r = validRange(req);
    if (!r) return res.status(400).json({ error: "bad_range" });
    const p = [r.from, r.to];
    const sW = `started_at >= $1::timestamptz AND started_at < ($2::date + 1)`;
    const pW = `played_at  >= $1::timestamptz AND played_at  < ($2::date + 1)`;
    const aW = `ts         >= $1::timestamptz AND ts         < ($2::date + 1)`;  // stream samples → ATH

    const totals = (await pool.query(`
      SELECT
        (SELECT COUNT(*)::int                          FROM listener_sessions   WHERE ${sW}) AS sessions,
        (SELECT COUNT(DISTINCT NULLIF(lid,''))::int    FROM listener_sessions   WHERE ${sW}) AS unique_listeners,
        (SELECT COALESCE(SUM(duration_sec),0)::bigint  FROM listener_sessions   WHERE ${sW}) AS listen_sec,
        (SELECT COALESCE(SUM(listeners),0)::bigint     FROM station_stream_samples WHERE ${aW}) AS ath_min,
        (SELECT COUNT(*)::int                          FROM station_play_history WHERE ${pW}) AS performances`, p)).rows[0];

    const byAccount = (await pool.query(`
      WITH sess AS (
        SELECT s.license_key_id AS lk, COUNT(*)::int AS sessions,
               COUNT(DISTINCT NULLIF(ls.lid,''))::int AS uniq, COALESCE(SUM(ls.duration_sec),0)::bigint AS listen_sec
          FROM listener_sessions ls JOIN stations s ON s.uuid = ls.station_uuid WHERE ls.${sW} GROUP BY s.license_key_id),
      plays AS (
        SELECT s.license_key_id AS lk, COUNT(*)::int AS performances
          FROM station_play_history ph JOIN stations s ON s.uuid = ph.station_uuid WHERE ph.${pW} GROUP BY s.license_key_id),
      ath AS (
        SELECT s.license_key_id AS lk, COALESCE(SUM(ss.listeners),0)::bigint AS ath_min
          FROM station_stream_samples ss JOIN stations s ON s.uuid = ss.station_uuid WHERE ss.${aW} GROUP BY s.license_key_id)
      SELECT l.id, l.email, l.plan,
             COALESCE(sess.sessions,0) AS sessions, COALESCE(sess.uniq,0) AS uniq,
             COALESCE(sess.listen_sec,0) AS listen_sec, COALESCE(ath.ath_min,0) AS ath_min,
             COALESCE(plays.performances,0) AS performances
        FROM licenses l LEFT JOIN sess ON sess.lk = l.id LEFT JOIN plays ON plays.lk = l.id LEFT JOIN ath ON ath.lk = l.id
       WHERE COALESCE(sess.sessions,0) > 0 OR COALESCE(plays.performances,0) > 0 OR COALESCE(ath.ath_min,0) > 0
       ORDER BY listen_sec DESC, l.email`, p)).rows;

    const byStation = (await pool.query(`
      WITH sess AS (
        SELECT station_uuid, COUNT(*)::int AS sessions, COUNT(DISTINCT NULLIF(lid,''))::int AS uniq,
               COALESCE(SUM(duration_sec),0)::bigint AS listen_sec FROM listener_sessions WHERE ${sW} GROUP BY station_uuid),
      plays AS (
        SELECT station_uuid, COUNT(*)::int AS performances FROM station_play_history WHERE ${pW} GROUP BY station_uuid),
      ath AS (
        SELECT station_uuid, COALESCE(SUM(listeners),0)::bigint AS ath_min FROM station_stream_samples WHERE ${aW} GROUP BY station_uuid)
      SELECT s.uuid, s.name, l.email AS account, m.display_name,
             COALESCE(sess.sessions,0) AS sessions, COALESCE(sess.uniq,0) AS uniq,
             COALESCE(sess.listen_sec,0) AS listen_sec, COALESCE(ath.ath_min,0) AS ath_min,
             COALESCE(plays.performances,0) AS performances
        FROM stations s JOIN licenses l ON l.id = s.license_key_id
        LEFT JOIN station_metadata m ON m.station_uuid = s.uuid
        LEFT JOIN sess ON sess.station_uuid = s.uuid LEFT JOIN plays ON plays.station_uuid = s.uuid LEFT JOIN ath ON ath.station_uuid = s.uuid
       WHERE COALESCE(sess.sessions,0) > 0 OR COALESCE(plays.performances,0) > 0 OR COALESCE(ath.ath_min,0) > 0
       ORDER BY listen_sec DESC, account`, p)).rows;

    const byDay = (await pool.query(`
      SELECT to_char(date_trunc('day', started_at),'YYYY-MM-DD') AS day,
             COALESCE(SUM(duration_sec),0)::bigint AS listen_sec, COUNT(*)::int AS sessions
        FROM listener_sessions WHERE ${sW} GROUP BY 1 ORDER BY 1`, p)).rows;

    res.json({ from: r.from, to: r.to, totals, byAccount, byStation, byDay });
  } catch (e) { console.error("[platform/rollup]", e.message); res.status(500).json({ error: "server_error" }); }
});

// Per-performance detail across ALL stations for the range — the source rows the dashboard turns
// into the ASCAP / BMI / standard CSV (same column formats as the desktop play log, but with the
// REAL duration_ms, not a placeholder). Capped; `truncated` flags when the cap is hit.
app.get("/api/platform/performances", requirePlatform, async (req, res) => {
  try {
    const r = validRange(req);
    if (!r) return res.status(400).json({ error: "bad_range" });
    const CAP = 100000;
    const { rows } = await pool.query(
      `SELECT ph.title, ph.artist, ph.duration_ms, ph.played_at, ph.category_code, ph.show_name,
              l.email AS account, COALESCE(m.display_name, s.name) AS station
         FROM station_play_history ph
         JOIN stations s ON s.uuid = ph.station_uuid
         JOIN licenses l ON l.id = s.license_key_id
         LEFT JOIN station_metadata m ON m.station_uuid = s.uuid
        WHERE ph.played_at >= $1::timestamptz AND ph.played_at < ($2::date + 1) AND COALESCE(ph.title,'') <> ''
        ORDER BY ph.played_at
        LIMIT ${CAP + 1}`,
      [r.from, r.to]
    );
    const truncated = rows.length > CAP;
    res.json({ from: r.from, to: r.to, truncated, performances: truncated ? rows.slice(0, CAP) : rows });
  } catch (e) { console.error("[platform/performances]", e.message); res.status(500).json({ error: "server_error" }); }
});
// Never leak pin_hash to the client.
function publicUser(u) {
  return {
    id: u.id, username: u.username, display_name: u.display_name, role: u.role,
    has_pin: !!u.pin_hash, locked: !!(u.locked_until && new Date(u.locked_until) > new Date()),
    created_at: u.created_at,
  };
}

// IP rate limit on auth endpoints; per-account lockout (below) is the second layer.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 40,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "too_many_attempts" },
});

// ── Customer accounts (email + password) ──────────────────────────────────
// The simplified customer identity: free signup → 15-day trial → paid subscription. Distinct from
// the dashboard's license-key + PIN auth (/api/auth/*); these live at /api/user/*. JWT carries
// typ:"user". The license remains the internal entitlement; this hides it behind email+password.
const ACCOUNT_APP_URL = process.env.ACCOUNT_APP_URL || "https://ether-technologies.com";
const TRIAL_DAYS = 15;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function signUserToken(u) {
  return jwt.sign({ uid: u.id, email: u.email, typ: "user" }, JWT_SECRET, { expiresIn: JWT_TTL });
}
function requireUser(req, res, next) {
  const h = req.headers["authorization"] || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing_token" });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.typ !== "user") return res.status(401).json({ error: "invalid_token" });
    req.user = p; next();
  } catch { return res.status(401).json({ error: "invalid_token" }); }
}
// Current entitlement: an active paid license wins; else an unexpired trial; else expired/none.
async function userEntitlement(u) {
  if (u.license_key_id) {
    const { rows } = await pool.query(`SELECT plan, active FROM licenses WHERE id = $1`, [u.license_key_id]);
    if (rows[0] && rows[0].active) return { status: "active", plan: rows[0].plan, trial_days_left: 0 };
  }
  if (u.trial_ends_at) {
    const ms = new Date(u.trial_ends_at).getTime() - Date.now();
    if (ms > 0) return { status: "trial", plan: "trial", trial_days_left: Math.ceil(ms / 86400000) };
    return { status: "expired", plan: null, trial_days_left: 0 };
  }
  return { status: "none", plan: null, trial_days_left: 0 };
}
function publicAccount(u, ent) {
  return { id: u.id, name: u.name || null, email: u.email, email_verified: !!u.email_verified, trial_ends_at: u.trial_ends_at, entitlement: ent };
}
async function sendAccountEmail(to, subject, heading, body, button, opts = {}) {
  const from = process.env.FROM_EMAIL || "noreply@ether-technologies.com";
  const unsubUrl = opts.unsubscribeToken ? `${API_PUBLIC_URL}/u/${opts.unsubscribeToken}` : null;
  const html = emailShell({ heading, bodyHtml: `<p style="margin:0">${body}</p>`, button, unsubUrl });
  // RFC 8058 one-click unsubscribe for clients that surface it (Gmail/Apple Mail).
  const headers = unsubUrl ? { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined;
  try {
    await resend.emails.send(headers ? { from, to, subject, html, headers } : { from, to, subject, html });
  } catch (e) { console.error("[account-email]", e.message); }
}

// Free signup → create the account, start the 15-day trial, send a (non-blocking) verify email.
app.post("/api/user/signup", authLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const name = String(req.body?.name || "").trim().slice(0, 80) || null;
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "invalid_email" });
    if (password.length < 8) return res.status(400).json({ error: "weak_password" });
    if ((await pool.query(`SELECT 1 FROM users WHERE email = $1`, [email])).rows[0]) return res.status(409).json({ error: "email_taken" });
    const hash = await bcrypt.hash(password, 12);
    const verifyToken = crypto.randomBytes(24).toString("base64url");
    const unsubToken = crypto.randomBytes(18).toString("base64url");
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, verify_token, unsubscribe_token, trial_ends_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '${TRIAL_DAYS} days') RETURNING *`,
      [name, email, hash, verifyToken, unsubToken]
    );
    const u = rows[0];
    const hi = name ? `Welcome, ${escapeHtml(name.split(/\s+/)[0])}` : "Welcome to Ether";
    sendAccountEmail(email, "Verify your Ether account", hi,
      `Your ${TRIAL_DAYS}-day free trial has started. Confirm your email address to secure your account and keep your station online.`,
      { url: `${ACCOUNT_APP_URL}/verify?token=${verifyToken}`, label: "Verify email" },
      { unsubscribeToken: unsubToken });
    res.json({ token: signUserToken(u), account: publicAccount(u, await userEntitlement(u)) });
  } catch (e) { console.error("[user/signup]", e.message); res.status(500).json({ error: "server_error" }); }
});

app.post("/api/user/login", authLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const u = (await pool.query(`SELECT * FROM users WHERE email = $1`, [email])).rows[0];
    if (!u || !(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: "invalid_credentials" });
    await pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [u.id]);
    res.json({ token: signUserToken(u), account: publicAccount(u, await userEntitlement(u)) });
  } catch (e) { console.error("[user/login]", e.message); res.status(500).json({ error: "server_error" }); }
});

app.get("/api/user/me", requireUser, async (req, res) => {
  try {
    const u = (await pool.query(`SELECT * FROM users WHERE id = $1`, [req.user.uid])).rows[0];
    if (!u) return res.status(404).json({ error: "not_found" });
    res.json({ account: publicAccount(u, await userEntitlement(u)) });
  } catch (e) { console.error("[user/me]", e.message); res.status(500).json({ error: "server_error" }); }
});

app.post("/api/user/verify", async (req, res) => {
  try {
    const token = String(req.body?.token || "");
    if (!token) return res.status(400).json({ error: "missing_token" });
    const r = await pool.query(`UPDATE users SET email_verified = true, verify_token = NULL WHERE verify_token = $1 RETURNING id`, [token]);
    if (!r.rowCount) return res.status(400).json({ error: "invalid_token" });
    res.json({ ok: true });
  } catch (e) { console.error("[user/verify]", e.message); res.status(500).json({ error: "server_error" }); }
});

app.post("/api/user/forgot", authLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const u = (await pool.query(`SELECT id FROM users WHERE email = $1`, [email])).rows[0];
    if (u) {
      const token = crypto.randomBytes(24).toString("base64url");
      await pool.query(`UPDATE users SET reset_token = $1, reset_expires = NOW() + INTERVAL '1 hour' WHERE id = $2`, [token, u.id]);
      sendAccountEmail(email, "Reset your Ether password", "Password reset",
        `We received a request to reset your password. This link expires in 1 hour — if you didn't request it, ignore this email.`,
        { url: `${ACCOUNT_APP_URL}/reset?token=${token}`, label: "Reset password" });
    }
    res.json({ ok: true });   // never reveal whether the email exists
  } catch (e) { console.error("[user/forgot]", e.message); res.status(500).json({ error: "server_error" }); }
});

app.post("/api/user/reset", authLimiter, async (req, res) => {
  try {
    const token = String(req.body?.token || "");
    const password = String(req.body?.password || "");
    if (password.length < 8) return res.status(400).json({ error: "weak_password" });
    const u = (await pool.query(`SELECT id FROM users WHERE reset_token = $1 AND reset_expires > NOW()`, [token])).rows[0];
    if (!u) return res.status(400).json({ error: "invalid_or_expired" });
    const hash = await bcrypt.hash(password, 12);
    await pool.query(`UPDATE users SET password_hash = $1, reset_token = NULL, reset_expires = NULL WHERE id = $2`, [hash, u.id]);
    res.json({ ok: true });
  } catch (e) { console.error("[user/reset]", e.message); res.status(500).json({ error: "server_error" }); }
});

// Email unsubscribe (CAN-SPAM). GET = human clicks the footer link → opt out, land on the
// confirmation page. POST = RFC 8058 one-click (List-Unsubscribe-Post). Idempotent; never
// reveals whether the token matched. Opting out stops marketing only — transactional mail
// (verify / password reset / billing receipts) still sends.
async function applyUnsubscribe(token) {
  if (!token) return;
  try { await pool.query(`UPDATE users SET marketing_opt_out = true WHERE unsubscribe_token = $1`, [token]); }
  catch (e) { console.error("[unsubscribe]", e.message); }
}
app.get("/u/:token", async (req, res) => {
  await applyUnsubscribe(req.params.token);
  res.redirect(302, `${ACCOUNT_APP_URL.replace(/\/$/, "")}/unsubscribe?done=1`);
});
app.post("/u/:token", async (req, res) => {
  await applyUnsubscribe(req.params.token);
  res.status(200).json({ ok: true });
});

// Desktop activation bridge — the desktop signs in with the web account's email + password instead
// of pasting a key. We authenticate, resolve the license matching the user's entitlement (their paid
// license, or a Network trial license that expires with the trial), register THIS machine as a seat,
// and return the key + plan so the desktop activates through its normal plan_tier path. trial_ends_at
// lets the desktop run the Adobe-style end-of-trial gate (Subscribe, or continue on free Solo).
app.post("/api/user/desktop-activate", authLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const u = (await pool.query(`SELECT * FROM users WHERE email = $1`, [email])).rows[0];
    if (!u || !(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: "invalid_credentials" });

    const ent = await userEntitlement(u);
    if (ent.status === "expired" || ent.status === "none")
      return res.status(403).json({ error: "trial_expired", message: "Your free trial has ended. Subscribe to activate Ether, or continue on the free Solo plan." });

    // Resolve the license to activate: the user's paid license if linked, else an existing/new
    // Network trial license tied to this email (plaintext key so we can always hand it back).
    let license = null;
    if (u.license_key_id)
      license = (await pool.query(`SELECT * FROM licenses WHERE id = $1 AND active = true`, [u.license_key_id])).rows[0] || null;
    if (!license) {
      license = (await pool.query(
        `SELECT * FROM licenses WHERE email = $1 AND expires_at IS NOT NULL AND active = true ORDER BY id DESC LIMIT 1`, [email]
      )).rows[0] || null;
      if (!license) {
        const rawKey = generateLicenseKey("station");
        license = (await pool.query(
          `INSERT INTO licenses (email, plan, license_key, key_prefix, expires_at, active)
           VALUES ($1, 'station', $2, $3, $4, true) RETURNING *`,
          [email, rawKey, rawKey.slice(0, 12), u.trial_ends_at]
        )).rows[0];
      }
      await pool.query(`UPDATE users SET license_key_id = $1 WHERE id = $2`, [license.id, u.id]);
    }

    // Register this machine as a seat (mirrors /validate). Trial keys store a plaintext license_key.
    const activationKey = license.license_key || `lic-${license.id}`;
    const limit = PLAN_MACHINE_LIMITS[license.plan] ?? 1;
    const mid = String(req.body.machine_id || "").trim() || `acct-${u.id}`;
    const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "").trim();
    const existing = await pool.query(
      `SELECT id FROM license_activations WHERE license_key=$1 AND machine_id=$2 AND deauthorized_at IS NULL`, [activationKey, mid]
    );
    if (existing.rows.length) {
      await pool.query(`UPDATE license_activations SET last_seen=NOW(), ip_address=$1 WHERE id=$2`, [ip, existing.rows[0].id]);
    } else {
      const { rows: active } = await pool.query(
        `SELECT machine_id, machine_name, os, activated_at, last_seen FROM license_activations WHERE license_key=$1 AND deauthorized_at IS NULL ORDER BY last_seen DESC`, [activationKey]
      );
      if (active.length >= limit)
        return res.status(403).json({ error: "activation_limit_reached", message: `This account is already active on ${active.length} of ${limit} machines. Deactivate one to sign in here.`, limit, activations: active });
      await pool.query(
        `INSERT INTO license_activations (license_key, machine_id, machine_name, os, ip_address)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (license_key, machine_id) DO UPDATE SET machine_name=EXCLUDED.machine_name, os=EXCLUDED.os, ip_address=EXCLUDED.ip_address, last_seen=NOW(), deauthorized_at=NULL`,
        [activationKey, mid, req.body.machine_name || null, req.body.os || null, ip]
      );
    }
    await pool.query(`UPDATE licenses SET last_validated=NOW() WHERE id=$1`, [license.id]);

    res.json({
      ok: true,
      plan: license.plan,
      email: u.email,
      name: u.name || null,
      license_key: license.license_key || null,   // trial keys are plaintext; paid bcrypt keys omit it
      trial: ent.status === "trial",
      trial_ends_at: ent.status === "trial" ? u.trial_ends_at : null,
    });
  } catch (e) { console.error("[user/desktop-activate]", e.message); res.status(500).json({ error: "server_error" }); }
});

// Start a Stripe Checkout to convert a trial into a paid subscription. Ties the session to the
// user (client_reference_id) + plan (metadata) so the webhook can flip THIS account to paid.
app.post("/api/user/checkout", requireUser, async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: "stripe_unconfigured" });
    const plan = String(req.body?.plan || "");
    const priceId = plan === "station" ? process.env.PRICE_STATION : plan === "pro" ? process.env.PRICE_PRO : null;
    if (!priceId) return res.status(400).json({ error: "invalid_plan" });
    const u = (await pool.query(`SELECT id, email FROM users WHERE id = $1`, [req.user.uid])).rows[0];
    if (!u) return res.status(404).json({ error: "not_found" });
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    const base = ACCOUNT_APP_URL.replace(/\/$/, "");
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: u.email,
      client_reference_id: String(u.id),
      metadata: { user_id: String(u.id), plan },
      success_url: `${base}/?subscribed=1`,
      cancel_url: `${base}/`,
      allow_promotion_codes: true,
    });
    res.json({ url: session.url });
  } catch (e) { console.error("[user/checkout]", e.message); res.status(500).json({ error: "server_error", detail: e.message }); }
});

// First-admin bootstrap: paste license key + pick username + PIN. Allowed only
// when the license has no live users yet — no admin intervention, no hijacking an
// already-set-up account.
app.post("/api/auth/bootstrap-admin", authLimiter, async (req, res) => {
  try {
    const { license_key } = req.body || {};
    const username = normUsername(req.body?.username);
    const pin = req.body?.pin;
    if (!license_key?.trim())       return res.status(400).json({ error: "missing_license_key" });
    if (!isValidUsername(username)) return res.status(400).json({ error: "invalid_username" });
    if (!isValidPin(pin))           return res.status(400).json({ error: "invalid_pin", detail: "PIN must be 4 digits" });

    const license = await lookupLicense(license_key);
    if (!license) return res.status(401).json({ error: "invalid_license_key" });

    const { rows: existing } = await pool.query(
      `SELECT 1 FROM account_users WHERE license_key_id = $1 AND deleted_at IS NULL LIMIT 1`,
      [license.id]
    );
    if (existing.length) return res.status(409).json({ error: "already_bootstrapped" });

    const { rows } = await pool.query(
      `INSERT INTO account_users (license_key_id, username, display_name, role, pin_hash)
       VALUES ($1, $2, $2, 'admin', $3) RETURNING *`,
      [license.id, username, hashPin(pin)]
    );
    return res.json({ token: signAccountToken(rows[0]), user: publicUser(rows[0]) });
  } catch (e) {
    console.error("[auth/bootstrap]", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// Login: license_key identifies the account; username + PIN identify the operator.
app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const { license_key } = req.body || {};
    const username = normUsername(req.body?.username);
    const pin = req.body?.pin;
    if (!license_key?.trim() || !username || !pin) return res.status(400).json({ error: "missing_fields" });

    const license = await lookupLicense(license_key);
    if (!license) return res.status(401).json({ error: "invalid_credentials" });

    const { rows } = await pool.query(
      `SELECT * FROM account_users
       WHERE license_key_id = $1 AND lower(username) = lower($2) AND deleted_at IS NULL`,
      [license.id, username]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "invalid_credentials" });

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({ error: "locked", until: user.locked_until });
    }

    if (!verifyPin(pin, user.pin_hash)) {
      const fails = (user.failed_attempts || 0) + 1;
      const lock = fails >= PIN_MAX_FAILS ? new Date(Date.now() + PIN_LOCKOUT_MS) : null;
      await pool.query(
        `UPDATE account_users SET failed_attempts = $1, locked_until = $2, updated_at = NOW() WHERE id = $3`,
        [lock ? 0 : fails, lock, user.id]
      );
      if (lock) return res.status(423).json({ error: "locked", until: lock });
      return res.status(401).json({ error: "invalid_credentials" });
    }

    await pool.query(
      `UPDATE account_users SET failed_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = $1`,
      [user.id]
    );
    return res.json({ token: signAccountToken(user), user: publicUser(user) });
  } catch (e) {
    console.error("[auth/login]", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// Whoami — current operator + license summary (dashboard header).
app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT au.*, l.account_name, l.plan, l.email
       FROM account_users au JOIN licenses l ON l.id = au.license_key_id
       WHERE au.id = $1 AND au.deleted_at IS NULL`,
      [req.auth.uid]
    );
    const u = rows[0];
    if (!u) return res.status(401).json({ error: "invalid_token" });
    return res.json({ user: publicUser(u), account: { name: u.account_name, plan: u.plan, email: u.email } });
  } catch (e) {
    console.error("[auth/me]", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// All stations for the signed-in operator's license, with branding + live
// now-playing — the Phase 1 view-only payload (includes non-public stations).
app.get("/api/account/stations", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.uuid, s.name, s.nickname, s.frequency, s.call_letters, s.created_at,
              m.slug, m.display_name, m.logo_url, m.color_primary, m.color_secondary,
              m.description, m.public_enabled, m.stream_url,
              n.playing, n.title, n.artist, n.deck, n.decks, n.started_at, n.duration_sec, n.queue,
              n.updated_at AS now_playing_updated_at
       FROM stations s
       LEFT JOIN station_metadata    m ON m.station_uuid = s.uuid
       LEFT JOIN station_now_playing n ON n.station_uuid = s.uuid
       WHERE s.license_key_id = $1
       ORDER BY s.created_at ASC`,
      [req.auth.lk]
    );
    const stations = rows.map(r => ({
      uuid: r.uuid, name: r.name, nickname: r.nickname, frequency: r.frequency,
      call_letters: r.call_letters, created_at: r.created_at,
      metadata: {
        slug: r.slug, display_name: r.display_name, logo_url: r.logo_url,
        color_primary: r.color_primary, color_secondary: r.color_secondary,
        description: r.description, public_enabled: !!r.public_enabled, stream_url: r.stream_url,
      },
      now_playing: r.now_playing_updated_at ? {
        playing: r.playing, title: r.title, artist: r.artist, deck: r.deck, decks: r.decks || null,
        started_at: r.started_at, duration_sec: r.duration_sec, queue: r.queue || [],
        updated_at: r.now_playing_updated_at,
      } : null,
    }));
    return res.json({ stations });
  } catch (e) {
    console.error("[account/stations]", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// Delete one of the caller's OWN stations — account admin only, scoped to the caller's license so an
// operator can never reach another account's station. Cascades station_* data + purges its mutation log.
app.delete("/api/account/stations/:uuid", requireAuthAdmin, async (req, res) => {
  const uuid = String(req.params.uuid || "");
  if (!uuid) return res.status(400).json({ error: "bad_uuid" });
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT name FROM stations WHERE uuid = $1 AND license_key_id = $2`, [uuid, req.auth.lk]
    );
    if (!rows.length) { client.release(); return res.status(404).json({ error: "station_not_found" }); }
    await client.query("BEGIN");
    await client.query(`DELETE FROM mutations WHERE station_id = $1 OR (table_name = 'stations' AND row_id = $1)`, [uuid]);
    const del = await client.query(`DELETE FROM stations WHERE uuid = $1 AND license_key_id = $2`, [uuid, req.auth.lk]);
    await client.query("COMMIT");
    res.json({ ok: true, deleted: del.rowCount, name: rows[0].name });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[account/delete-station]", e.message);
    res.status(500).json({ error: "server_error", detail: e.message });
  } finally { client.release(); }
});

// ── User management (admin only) — Phase 1: list / create / reset-PIN ─────────
app.get("/api/account/users", requireAuthAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM account_users WHERE license_key_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC`,
      [req.auth.lk]
    );
    return res.json({ users: rows.map(publicUser) });
  } catch (e) {
    console.error("[account/users:list]", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/account/users", requireAuthAdmin, async (req, res) => {
  try {
    const username = normUsername(req.body?.username);
    const display_name = normUsername(req.body?.display_name) || username;
    const role = req.body?.role === "admin" ? "admin" : "user";
    const pin = req.body?.pin;
    if (!isValidUsername(username)) return res.status(400).json({ error: "invalid_username" });
    if (!isValidPin(pin))           return res.status(400).json({ error: "invalid_pin", detail: "PIN must be 4 digits" });

    const { rows: dup } = await pool.query(
      `SELECT 1 FROM account_users WHERE license_key_id = $1 AND lower(username) = lower($2) AND deleted_at IS NULL`,
      [req.auth.lk, username]
    );
    if (dup.length) return res.status(409).json({ error: "username_taken" });

    const { rows } = await pool.query(
      `INSERT INTO account_users (license_key_id, username, display_name, role, pin_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.auth.lk, username, display_name, role, hashPin(pin)]
    );
    return res.json({ user: publicUser(rows[0]) });
  } catch (e) {
    console.error("[account/users:create]", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// Reset a user's PIN (admin) — also clears any lockout.
app.post("/api/account/users/:id/pin", requireAuthAdmin, async (req, res) => {
  try {
    const pin = req.body?.pin;
    if (!isValidPin(pin)) return res.status(400).json({ error: "invalid_pin", detail: "PIN must be 4 digits" });
    const { rowCount } = await pool.query(
      `UPDATE account_users SET pin_hash = $1, failed_attempts = 0, locked_until = NULL, updated_at = NOW()
       WHERE id = $2 AND license_key_id = $3 AND deleted_at IS NULL`,
      [hashPin(pin), req.params.id, req.auth.lk]
    );
    if (!rowCount) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true });
  } catch (e) {
    console.error("[account/users:pin]", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// Mirror a desktop install's local console users up so the same people can sign in
// to the dashboard with the same name + PIN. License-key authenticated (like the
// now-playing push), one-way (install -> backend). Only users WITH a PIN are sent
// by the client (no-PIN users stay console-only; pin_hash is NOT NULL here). pin_hash
// arrives in the desktop's "salt:sha256" format, which verifyPin already understands.
// Upserts only 'install'-origin rows — a dashboard-managed username is never clobbered.
app.post("/api/account/users/sync", async (req, res) => {
  try {
    const key = req.headers["x-license-key"];
    if (!key) return res.status(401).json({ error: "missing_license_key" });
    const license = await lookupLicense(key);
    if (!license) return res.status(401).json({ error: "invalid_license_key" });

    const incoming = Array.isArray(req.body?.users) ? req.body.users : [];
    let created = 0, updated = 0, skipped = 0;
    const present = []; // lower(username) of every valid incoming user — for reconciliation
    for (const u of incoming) {
      const username = normUsername(u?.name);
      const pin_hash = typeof u?.pin_hash === "string" && u.pin_hash ? u.pin_hash : null;
      if (!isValidUsername(username) || !pin_hash) { skipped++; continue; }
      const role = u?.role === "admin" ? "admin" : "user";
      present.push(username.toLowerCase());

      const { rows } = await pool.query(
        `SELECT id, origin FROM account_users
         WHERE license_key_id = $1 AND lower(username) = lower($2) AND deleted_at IS NULL`,
        [license.id, username]
      );
      if (rows.length === 0) {
        await pool.query(
          `INSERT INTO account_users (license_key_id, username, display_name, role, pin_hash, origin)
           VALUES ($1, $2, $2, $3, $4, 'install')`,
          [license.id, username, role, pin_hash]
        );
        created++;
      } else if (rows[0].origin === "install") {
        await pool.query(
          `UPDATE account_users SET pin_hash = $1, role = $2, display_name = $3, updated_at = NOW() WHERE id = $4`,
          [pin_hash, role, username, rows[0].id]
        );
        updated++;
      } else {
        skipped++; // dashboard-managed username — leave it alone
      }
    }

    // Reconcile: revoke install-origin users that are no longer present (deleted on
    // the install, or had their PIN cleared so the client stopped sending them).
    // Only runs on a non-empty push, so a transient empty read can't mass-revoke.
    let revoked = 0;
    if (present.length > 0) {
      const r = await pool.query(
        `UPDATE account_users SET deleted_at = NOW(), updated_at = NOW()
         WHERE license_key_id = $1 AND origin = 'install' AND deleted_at IS NULL
           AND lower(username) <> ALL($2::text[])`,
        [license.id, present]
      );
      revoked = r.rowCount;
    }
    return res.json({ ok: true, created, updated, skipped, revoked });
  } catch (e) {
    console.error("[account/users:sync]", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// ── Control Center data mirror (Phase 2) ──────────────────────────────────────
// Install pushes its rows for one table up (x-license-key). Upserts into the mirror
// and tombstones rows it no longer sees (reconcile, non-empty pushes only).
app.post("/api/account/data/sync", async (req, res) => {
  try {
    const key = req.headers["x-license-key"];
    if (!key) return res.status(401).json({ error: "missing_license_key" });
    const license = await lookupLicense(key);
    if (!license) return res.status(401).json({ error: "invalid_license_key" });

    const stationUuid = String(req.body?.station_uuid || "");
    const table = String(req.body?.table || "");
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!stationUuid || !table) return res.status(400).json({ error: "missing_fields" });

    const { rows: own } = await pool.query(
      `SELECT 1 FROM stations WHERE uuid = $1 AND license_key_id = $2`, [stationUuid, license.id]
    );
    if (own.length === 0) return res.status(404).json({ error: "station_not_found" });

    // Dedupe by row_uuid (last wins) so a single multi-row upsert can't hit the same
    // conflict target twice, then upsert in chunks. A per-row await loop is fine for
    // ~50 categories but would be thousands of sequential round-trips for the song
    // library (~5,600 rows) — chunked multi-row INSERT keeps it to a handful.
    const byUuid = new Map();
    for (const r of rows) { if (r?.uuid) byUuid.set(String(r.uuid), r); }
    const present = [...byUuid.keys()];
    const entries = [...byUuid.entries()];
    const CHUNK = 500;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      const params = [stationUuid, table];
      const tuples = [];
      let p = 3;
      for (const [rowUuid, r] of chunk) {
        tuples.push(`($1,$2,$${p},$${p + 1},$${p + 2},NOW())`);
        params.push(rowUuid, JSON.stringify(r), r.deleted_at ?? null);
        p += 3;
      }
      await pool.query(
        `INSERT INTO station_cc_data (station_uuid, table_name, row_uuid, payload, deleted_at, updated_at)
         VALUES ${tuples.join(",")}
         ON CONFLICT (station_uuid, table_name, row_uuid) DO UPDATE SET
           payload = EXCLUDED.payload, deleted_at = EXCLUDED.deleted_at, updated_at = NOW()`,
        params
      );
    }
    if (present.length > 0) {
      await pool.query(
        `UPDATE station_cc_data SET deleted_at = NOW(), updated_at = NOW()
         WHERE station_uuid = $1 AND table_name = $2 AND deleted_at IS NULL
           AND row_uuid <> ALL($3::text[])`,
        [stationUuid, table, present]
      );
    }
    return res.json({ ok: true, count: present.length });
  } catch (e) {
    console.error("[account/data:sync]", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// Dashboard reads mirrored rows for one table of one of its stations (JWT).
app.get("/api/account/station/:uuid/data", requireAuth, async (req, res) => {
  try {
    const stationUuid = req.params.uuid;
    const table = String(req.query.table || "");
    if (!table) return res.status(400).json({ error: "missing_table" });
    const { rows: own } = await pool.query(
      `SELECT 1 FROM stations WHERE uuid = $1 AND license_key_id = $2`, [stationUuid, req.auth.lk]
    );
    if (own.length === 0) return res.status(404).json({ error: "station_not_found" });
    // Optional pagination (used by the song library; omitting both returns everything,
    // preserving the original behavior for categories/clocks/shows).
    const limit = req.query.limit != null ? Math.min(parseInt(req.query.limit, 10) || 0, 10000) : null;
    const offset = req.query.offset != null ? Math.max(parseInt(req.query.offset, 10) || 0, 0) : 0;
    let sql = `SELECT payload FROM station_cc_data
       WHERE station_uuid = $1 AND table_name = $2 AND deleted_at IS NULL
       ORDER BY updated_at ASC`;
    const params = [stationUuid, table];
    if (limit != null) { sql += ` LIMIT $3 OFFSET $4`; params.push(limit, offset); }
    const { rows } = await pool.query(sql, params);
    return res.json({ rows: rows.map((r) => r.payload) });
  } catch (e) {
    console.error("[account/data:get]", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// Dashboard (JWT-admin) gets a signed PUT URL to upload a NEW song's audio to R2.
// Keyed identically to the desktop's /audio/upload-url (`${license.id}/<file_key>`) so
// the install's fetchR2Track resolves it at play time. The backend mints a unique
// file_key to avoid collisions; the dashboard PUTs the bytes, then issues a
// `library:addSong` command carrying this file_key so the install creates the record.
app.post("/api/account/audio/upload-url", requireAuthAdmin, async (req, res) => {
  try {
    const licenseId = req.auth.lk;
    if (!getR2Client()) return res.status(503).json({ error: "r2_not_configured" });
    const ext = String(req.body?.ext || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!["mp3", "flac", "wav", "m4a", "aac", "ogg"].includes(ext)) {
      return res.status(400).json({ error: "bad_audio_type", detail: "ext must be mp3/flac/wav/m4a/aac/ogg" });
    }
    const fileKey = `cc-${require("crypto").randomUUID()}.${ext}`;
    const expiresInSeconds = 15 * 60;
    let signedUrl;
    try {
      signedUrl = await signR2PutUrl(`${licenseId}/${fileKey}`, expiresInSeconds);
    } catch (e) {
      const msg = (e && (e.message || e.name)) || "unknown";
      const epRaw = (process.env.R2_ENDPOINT || "").trim();
      const acct = (process.env.R2_ACCOUNT_ID || "").trim();
      const resolved = epRaw || `https://${acct}.r2.cloudflarestorage.com`;
      const masked = acct ? resolved.replace(acct, acct.slice(0, 4) + "…") : resolved;
      console.error("[account/audio/upload-url] signing failed:", e && (e.stack || e.message), "| endpoint:", masked, "| R2_ENDPOINT_set:", !!epRaw);
      // Fold the reason + resolved endpoint into the response so it's diagnosable from the UI.
      return res.status(500).json({ error: `signing_failed: ${msg}`, detail: `${msg} | endpoint=${masked} | R2_ENDPOINT_set=${!!epRaw}` });
    }
    res.json({ signed_url: signedUrl, file_key: fileKey, expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString() });
  } catch (e) {
    console.error("[account/audio/upload-url]", e.message);
    res.status(500).json({ error: "server_error" });
  }
});

// Install pushes new play_log rows for analytics (x-license-key). Append-only —
// dedupe by row_uuid, ON CONFLICT DO NOTHING (history only grows, never updates).
// played_at arrives as unix SECONDS (play_log.played_at). Chunked for backfills.
app.post("/api/account/play-history", async (req, res) => {
  try {
    const key = req.headers["x-license-key"];
    if (!key) return res.status(401).json({ error: "missing_license_key" });
    const license = await lookupLicense(key);
    if (!license) return res.status(401).json({ error: "invalid_license_key" });
    const stationUuid = String(req.body?.station_uuid || "");
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!stationUuid) return res.status(400).json({ error: "missing_fields" });
    const { rows: own } = await pool.query(
      `SELECT 1 FROM stations WHERE uuid = $1 AND license_key_id = $2`, [stationUuid, license.id]
    );
    if (own.length === 0) return res.status(404).json({ error: "station_not_found" });

    const byUuid = new Map();
    for (const r of rows) { if (r?.row_uuid) byUuid.set(String(r.row_uuid), r); }
    const entries = [...byUuid.values()];
    let inserted = 0;
    const CHUNK = 500;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      const params = [stationUuid];
      const tuples = [];
      let p = 2;
      for (const r of chunk) {
        tuples.push(`($1,$${p},$${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},to_timestamp($${p + 6}),$${p + 7})`);
        params.push(String(r.row_uuid), r.title ?? null, r.artist ?? null, r.category_code ?? null, r.show_name ?? null, r.duration_ms ?? null, Number(r.played_at) || 0, r.file_path ?? null);
        p += 8;
      }
      const result = await pool.query(
        `INSERT INTO station_play_history (station_uuid, row_uuid, title, artist, category_code, show_name, duration_ms, played_at, file_path)
         VALUES ${tuples.join(",")}
         ON CONFLICT (station_uuid, row_uuid) DO NOTHING`,
        params
      );
      inserted += result.rowCount || 0;
    }
    return res.json({ ok: true, received: entries.length, inserted });
  } catch (e) {
    console.error("[account/play-history]", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// Dashboard reads aggregated analytics for one station (JWT). Server-side GROUP BY so
// the browser never sees raw rows. range = 7d | 30d | 90d | all (default 30d).
app.get("/api/account/station/:uuid/analytics", requireAuth, async (req, res) => {
  try {
    const stationUuid = req.params.uuid;
    if (!(await stationReadable(req, stationUuid))) return res.status(404).json({ error: "station_not_found" });

    const days = { "7d": 7, "30d": 30, "90d": 90, "all": null }[String(req.query.range || "30d")];
    const rangeParam = days === undefined ? "30d" : String(req.query.range || "30d");
    const d = days === undefined ? 30 : days; // d is a whitelisted int or null — no injection
    const since = d ? `NOW() - INTERVAL '${d} days'` : `to_timestamp(0)`;
    const where = `station_uuid = $1 AND played_at >= ${since}`;
    const a = [stationUuid];

    const totals = (await pool.query(`SELECT COUNT(*)::int AS plays, COALESCE(SUM(duration_ms),0)::bigint AS total_ms FROM station_play_history WHERE ${where}`, a)).rows[0];
    const topSongs = (await pool.query(`SELECT title, artist, COUNT(*)::int AS plays FROM station_play_history WHERE ${where} AND title IS NOT NULL GROUP BY title, artist ORDER BY plays DESC LIMIT 20`, a)).rows;
    const topArtists = (await pool.query(`SELECT artist, COUNT(*)::int AS plays FROM station_play_history WHERE ${where} AND artist IS NOT NULL AND artist <> '' GROUP BY artist ORDER BY plays DESC LIMIT 20`, a)).rows;
    const byCategory = (await pool.query(`SELECT COALESCE(NULLIF(category_code,''),'(uncategorized)') AS category_code, COUNT(*)::int AS plays FROM station_play_history WHERE ${where} GROUP BY 1 ORDER BY plays DESC`, a)).rows;
    const byDay = (await pool.query(`SELECT to_char(date_trunc('day', played_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS plays FROM station_play_history WHERE ${where} GROUP BY 1 ORDER BY 1`, a)).rows;
    const recent = (await pool.query(`SELECT title, artist, category_code, show_name, duration_ms, played_at FROM station_play_history WHERE station_uuid = $1 ORDER BY played_at DESC LIMIT 50`, [stationUuid])).rows;

    return res.json({ range: rangeParam, totals, topSongs, topArtists, byCategory, byDay, recent });
  } catch (e) {
    console.error("[account/analytics]", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// Advertiser affidavit / proof-of-performance (JWT). Attributes aired spots to advertisers
// by joining play history to the mirrored `spots` table on file_path (a spot's stable
// identity — survives a title rename). Songs carry a file_path too but don't match a spot
// row, so they're naturally excluded. range = 7d|30d|90d|all (default 30d); optional
// ?advertiser= narrows to one client.
app.get("/api/account/station/:uuid/affidavit", requireAuth, async (req, res) => {
  try {
    const stationUuid = req.params.uuid;
    if (!(await stationReadable(req, stationUuid))) return res.status(404).json({ error: "station_not_found" });

    const days = { "7d": 7, "30d": 30, "90d": 90, "all": null }[String(req.query.range || "30d")];
    const rangeParam = days === undefined ? "30d" : String(req.query.range || "30d");
    const d = days === undefined ? 30 : days; // whitelisted int or null — no injection
    const since = d ? `NOW() - INTERVAL '${d} days'` : `to_timestamp(0)`;

    const advFilter = req.query.advertiser ? String(req.query.advertiser).slice(0, 200) : null;
    const a = [stationUuid];
    let advClause = "";
    if (advFilter) { a.push(advFilter); advClause = ` AND s.advertiser = $2`; }

    // Mirrored spots (keyed by file_path) ⋈ aired plays in range.
    const base = `
      WITH spot AS (
        SELECT payload->>'file_path' AS file_path,
               NULLIF(TRIM(payload->>'advertiser'), '') AS advertiser,
               payload->>'title'     AS spot_title,
               NULLIF(payload->>'isci_code','')  AS isci_code,
               NULLIF(payload->>'spot_type','')  AS spot_type,
               NULLIF(payload->>'length_sec','') AS length_sec
        FROM station_cc_data
        WHERE station_uuid = $1 AND table_name = 'spots' AND deleted_at IS NULL
          AND COALESCE(payload->>'file_path','') <> ''
      ),
      aired AS (
        SELECT file_path, played_at
        FROM station_play_history
        WHERE station_uuid = $1 AND played_at >= ${since} AND COALESCE(file_path,'') <> ''
      ),
      joined AS (
        SELECT s.advertiser, s.spot_title, s.isci_code, s.spot_type, s.length_sec, ap.played_at
        FROM aired ap JOIN spot s ON s.file_path = ap.file_path
        WHERE TRUE${advClause}
      )`;

    const totals = (await pool.query(`${base}
      SELECT COUNT(*)::int AS spins,
             COUNT(DISTINCT advertiser)::int AS advertisers,
             COUNT(DISTINCT spot_title)::int AS spots
      FROM joined`, a)).rows[0];

    const byAdvertiser = (await pool.query(`${base}
      SELECT COALESCE(advertiser,'(unattributed)') AS advertiser,
             COUNT(*)::int AS spins,
             COUNT(DISTINCT spot_title)::int AS spots
      FROM joined GROUP BY 1 ORDER BY spins DESC, advertiser`, a)).rows;

    const bySpot = (await pool.query(`${base}
      SELECT COALESCE(advertiser,'(unattributed)') AS advertiser,
             spot_title AS title, isci_code, spot_type, length_sec,
             COUNT(*)::int AS spins,
             to_char(MIN(played_at),'YYYY-MM-DD HH24:MI') AS first_aired,
             to_char(MAX(played_at),'YYYY-MM-DD HH24:MI') AS last_aired
      FROM joined GROUP BY advertiser, spot_title, isci_code, spot_type, length_sec
      ORDER BY advertiser, spins DESC`, a)).rows;

    const asRun = (await pool.query(`${base}
      SELECT COALESCE(advertiser,'(unattributed)') AS advertiser,
             spot_title AS title, isci_code,
             to_char(played_at,'YYYY-MM-DD HH24:MI:SS') AS played_at
      FROM joined ORDER BY played_at DESC LIMIT 2000`, a)).rows;

    return res.json({ range: rangeParam, advertiser: advFilter, totals, byAdvertiser, bySpot, asRun });
  } catch (e) {
    console.error("[account/affidavit]", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// Dashboard-only (JWT, PRIVATE — never exposed on any /public endpoint) listener
// metrics for one station. "now" + byCountry are computed from the live SSE
// connections (the listener page reports its Cloudflare country); peak/trend come
// from periodic samples. range = 7d|30d|90d|all (default 7d).
app.get("/api/account/station/:uuid/listeners", requireAuth, async (req, res) => {
  try {
    const stationUuid = req.params.uuid;
    if (!(await stationReadable(req, stationUuid))) return res.status(404).json({ error: "station_not_found" });
    const meta = (await pool.query(`SELECT slug FROM station_metadata WHERE station_uuid = $1`, [stationUuid])).rows[0];
    const slug = meta?.slug || null;

    let now = 0;
    const ccMap = new Map();
    const regionMap = new Map();   // "region|cc" → count (region scoped to its country)
    if (slug && streamClients.has(slug)) {
      for (const c of streamClients.get(slug)) {
        if (c.writableEnded) continue;
        now++;
        const cc = c._cc || "??";
        ccMap.set(cc, (ccMap.get(cc) || 0) + 1);
        if (c._region) { const k = `${c._region}|${cc}`; regionMap.set(k, (regionMap.get(k) || 0) + 1); }
      }
    }
    const byCountry = [...ccMap.entries()].map(([cc, count]) => ({ cc, count })).sort((a, b) => b.count - a.count);
    const byRegion = [...regionMap.entries()].map(([k, count]) => { const [region, cc] = k.split("|"); return { region, cc, count }; }).sort((a, b) => b.count - a.count);

    const d = { "7d": 7, "30d": 30, "90d": 90, "all": null }[String(req.query.range || "7d")];
    const days = d === undefined ? 7 : d;
    const since = days ? `NOW() - INTERVAL '${days} days'` : `to_timestamp(0)`;
    const peak = (await pool.query(`SELECT COALESCE(MAX(count),0)::int AS peak FROM station_listener_samples WHERE station_uuid = $1 AND ts >= ${since}`, [stationUuid])).rows[0].peak;
    const trend = (await pool.query(`SELECT to_char(date_trunc('hour', ts), 'YYYY-MM-DD HH24:00') AS hour, MAX(count)::int AS peak FROM station_listener_samples WHERE station_uuid = $1 AND ts >= ${since} GROUP BY 1 ORDER BY 1`, [stationUuid])).rows;

    return res.json({ now, byCountry, byRegion, peak, trend });
  } catch (e) {
    console.error("[account/listeners]", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// Audience analytics (Phase 3c) — from the per-session log: total sessions, unique listeners
// (anonymous lid), total listening hours (TLH), avg session length, listenership by day, tune-in by
// hour-of-day, and by country/state/city. Plus peak concurrent + concurrent trend from samples.
app.get("/api/account/station/:uuid/listenership", requireAuth, async (req, res) => {
  try {
    const stationUuid = req.params.uuid;
    if (!(await stationReadable(req, stationUuid))) return res.status(404).json({ error: "station_not_found" });

    const d = { "7d": 7, "30d": 30, "90d": 90, "all": null }[String(req.query.range || "30d")];
    const days = d === undefined ? 30 : d;
    const since = days ? `NOW() - INTERVAL '${days} days'` : `to_timestamp(0)`;
    const W = `station_uuid = $1 AND started_at >= ${since}`;

    const totals = (await pool.query(
      `SELECT COUNT(*)::int AS sessions,
              COUNT(DISTINCT NULLIF(lid,''))::int AS unique_listeners,
              COALESCE(SUM(duration_sec),0)::bigint AS tlh_sec,
              COALESCE(ROUND(AVG(duration_sec)),0)::int AS avg_sec
       FROM listener_sessions WHERE ${W}`, [stationUuid])).rows[0];
    const byDay = (await pool.query(
      `SELECT to_char(date_trunc('day', started_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS sessions, COUNT(DISTINCT NULLIF(lid,''))::int AS uniq
       FROM listener_sessions WHERE ${W} GROUP BY 1 ORDER BY 1`, [stationUuid])).rows;
    const byHour = (await pool.query(
      `SELECT EXTRACT(HOUR FROM started_at)::int AS hour, COUNT(*)::int AS sessions, COUNT(DISTINCT NULLIF(lid,''))::int AS uniq
       FROM listener_sessions WHERE ${W} GROUP BY 1 ORDER BY 1`, [stationUuid])).rows;
    const byCountry = (await pool.query(
      `SELECT cc, COUNT(*)::int AS sessions, COUNT(DISTINCT NULLIF(lid,''))::int AS uniq FROM listener_sessions WHERE ${W} AND COALESCE(cc,'') <> '' GROUP BY 1 ORDER BY uniq DESC, sessions DESC LIMIT 10`, [stationUuid])).rows;
    const byRegion = (await pool.query(
      `SELECT region, cc, COUNT(*)::int AS sessions, COUNT(DISTINCT NULLIF(lid,''))::int AS uniq FROM listener_sessions WHERE ${W} AND COALESCE(region,'') <> '' GROUP BY 1,2 ORDER BY uniq DESC, sessions DESC LIMIT 10`, [stationUuid])).rows;
    const byCity = (await pool.query(
      `SELECT city, cc, COUNT(*)::int AS sessions, COUNT(DISTINCT NULLIF(lid,''))::int AS uniq FROM listener_sessions WHERE ${W} AND COALESCE(city,'') <> '' GROUP BY 1,2 ORDER BY uniq DESC, sessions DESC LIMIT 10`, [stationUuid])).rows;

    const peakConcurrent = (await pool.query(`SELECT COALESCE(MAX(count),0)::int AS peak FROM station_listener_samples WHERE station_uuid = $1 AND ts >= ${since}`, [stationUuid])).rows[0].peak;
    const concurrent = (await pool.query(`SELECT to_char(date_trunc('hour', ts), 'YYYY-MM-DD HH24:00') AS ts, MAX(count)::int AS count FROM station_listener_samples WHERE station_uuid = $1 AND ts >= ${since} GROUP BY 1 ORDER BY 1`, [stationUuid])).rows;

    return res.json({
      totals: {
        sessions: totals.sessions,
        unique: totals.unique_listeners,
        tlhHours: Math.round(Number(totals.tlh_sec) / 360) / 10,
        avgSessionSec: totals.avg_sec,
        peakConcurrent,
      },
      byDay, byHour, byCountry, byRegion, byCity, concurrent,
    });
  } catch (e) {
    console.error("[account/listenership]", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

// ── Billing (Phase 4) ──────────────────────────────────────────────────────
// The dashboard NEVER talks to Stripe directly — these JWT endpoints proxy to
// Stripe with the server-side secret key. GET returns live plan/status; /portal
// mints a Stripe-hosted Customer Portal session and returns its URL.
app.get("/api/account/billing", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT plan, stripe_sub_id, email FROM licenses WHERE id = $1`, [req.auth.lk]);
    const lic = rows[0];
    if (!lic) return res.status(404).json({ error: "license_not_found" });
    let status = null, renewsAt = null, cancelAtPeriodEnd = false;
    if (lic.stripe_sub_id && process.env.STRIPE_SECRET_KEY) {
      try {
        const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
        const sub = await stripe.subscriptions.retrieve(lic.stripe_sub_id);
        status = sub.status;
        renewsAt = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
        cancelAtPeriodEnd = !!sub.cancel_at_period_end;
      } catch (e) { console.warn("[account/billing] sub retrieve failed:", e.message); }
    }
    return res.json({ plan: lic.plan, email: lic.email, manageable: !!lic.stripe_sub_id, status, renewsAt, cancelAtPeriodEnd });
  } catch (e) {
    console.error("[account/billing]", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/account/billing/portal", requireAuth, async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: "stripe_unconfigured" });
    const { rows } = await pool.query(`SELECT stripe_sub_id FROM licenses WHERE id = $1`, [req.auth.lk]);
    const subId = rows[0]?.stripe_sub_id;
    if (!subId) return res.status(400).json({ error: "no_subscription" });
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    const sub = await stripe.subscriptions.retrieve(subId);
    const customer = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
    if (!customer) return res.status(400).json({ error: "no_customer" });
    // return_url restricted to known dashboard origins (no open redirect).
    const origin = req.headers.origin || "";
    const returnUrl = /^https:\/\/(app\.ether-technologies\.com|ether-dashboard\.pages\.dev)$/.test(origin) ? origin : "https://app.ether-technologies.com";
    const session = await stripe.billingPortal.sessions.create({ customer, return_url: returnUrl });
    return res.json({ url: session.url });
  } catch (e) {
    console.error("[account/billing/portal]", e.message);
    return res.status(500).json({ error: "portal_failed", detail: e.message });
  }
});

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
    const { license_key, email, machine_name, os } = req.body;
    if (!license_key?.trim() || !email?.trim())
      return res.status(400).json({ valid: false, error: "Missing license_key or email" });
    // machine_id is optional for backward-compat — builds that don't send one still activate, on a
    // stable per-email seat. (Newer builds send a real machine_id for proper per-machine seats.)
    const mid = req.body.machine_id?.trim() || `legacy-${email.trim().toLowerCase()}`;

    // 1. Verify license exists + is active (bcrypt OR legacy plaintext key), then match email.
    //    Uses lookupLicense so admin/platform-issued keys (bcrypt key_hash, no plaintext) activate.
    const license = await lookupLicense(license_key.trim());
    if (!license || (license.email || "").toLowerCase() !== email.trim().toLowerCase())
      return res.json({ valid: false, error: "License key not found or does not match this email." });

    // Activation rows key on the plaintext key for legacy licenses; bcrypt licenses have none, so
    // use a stable per-license token instead (license.id is the PK → guaranteed unique).
    const activationKey = license.license_key || `lic-${license.id}`;
    const limit = PLAN_MACHINE_LIMITS[license.plan] ?? 1;
    const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "").trim();

    // 2. Check if this machine is already activated for this license.
    //    A deauthorized row (deauthorized_at IS NOT NULL) doesn't count — a customer
    //    who deauthorizes a machine then re-installs on it should reactivate cleanly.
    const { rows: existingActivations } = await pool.query(
      "SELECT * FROM license_activations WHERE license_key=$1 AND machine_id=$2 AND deauthorized_at IS NULL",
      [activationKey, mid]
    );

    if (existingActivations.length) {
      // Already activated on this machine → just update last_seen
      await pool.query(
        "UPDATE license_activations SET last_seen=NOW(), ip_address=$1 WHERE id=$2",
        [ip, existingActivations[0].id]
      );
    } else {
      // 3. Not activated here — check if we have room. Only active (non-deauthorized) seats count.
      const { rows: activeList } = await pool.query(
        "SELECT machine_id, machine_name, os, activated_at, last_seen FROM license_activations WHERE license_key=$1 AND deauthorized_at IS NULL ORDER BY last_seen DESC",
        [activationKey]
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

      // 4. Register this machine as a new activation. UPSERT because a prior
      //    deauthorized row for the same (license_key, machine_id) pair may
      //    exist — UNIQUE(license_key, machine_id) on the table means a plain
      //    INSERT would collide. Reactivating clears deauthorized_at and refreshes
      //    last_seen/ip_address so the row reads as a fresh seat.
      await pool.query(
        `INSERT INTO license_activations (license_key, machine_id, machine_name, os, ip_address)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (license_key, machine_id) DO UPDATE SET
           machine_name    = EXCLUDED.machine_name,
           os              = EXCLUDED.os,
           ip_address      = EXCLUDED.ip_address,
           last_seen       = NOW(),
           deauthorized_at = NULL`,
        [activationKey, mid, machine_name || null, os || null, ip]
      );
      console.log(`[Activation] ${activationKey} → ${machine_name || mid.slice(0, 8)} (${activeList.length + 1}/${limit})`);
    }

    await pool.query("UPDATE licenses SET last_validated=NOW() WHERE id=$1", [license.id]);
    res.json({
      valid: true,
      plan: license.plan,
      email: license.email,
      machine_limit: limit,
      license_key: license.license_key || license_key.trim(),
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
      "SELECT machine_id, machine_name, os, ip_address, activated_at, last_seen FROM license_activations WHERE license_key=$1 AND deauthorized_at IS NULL ORDER BY last_seen DESC",
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

    // Soft delete: set deauthorized_at instead of DELETE, so the row is preserved
    // for audit/history. Only flips currently-active rows; re-deauthorizing a
    // deauthorized seat is a no-op.
    const { rowCount } = await pool.query(
      "UPDATE license_activations SET deauthorized_at=NOW() WHERE license_key=$1 AND machine_id=$2 AND deauthorized_at IS NULL",
      [key, machine_id.trim()]
    );
    console.log(`[Deactivation] ${key} → ${machine_id.slice(0, 8)} (deauthorized ${rowCount})`);
    res.json({ ok: true, removed: rowCount });
  } catch (e) {
    console.error("[/licenses/:key/deactivate]", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Onboarding (onboarding-spec-v1.md) ────────────────────────
//
// POST /account/create   First-launch "Create new account" path. Sets the
//                        license's account_name + onboarded_at, creates the
//                        first station, and binds this machine's seat to it,
//                        all in one transaction.

app.post("/account/create", async (req, res) => {
  try {
    const { license_key, account_name, station, machine_id, machine_name } = req.body || {};
    const rawKey = license_key?.trim();

    // Required-field check. account_name is optional per spec; station fields
    // beyond name are also optional.
    if (!rawKey || !machine_id?.trim() || !station?.name?.trim()) {
      return res.status(400).json({
        error: "missing_fields",
        detail: "license_key, machine_id, and station.name are required",
      });
    }

    // Reuse lookupLicense (B-12) so both bcrypt and legacy plaintext keys work.
    const license = await lookupLicense(rawKey);
    if (!license) return res.status(401).json({ error: "invalid_license_key" });

    const stationUuid = crypto.randomUUID();
    const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "").trim();

    // license_activations.license_key is NOT NULL. For legacy plaintext rows
    // license.license_key matches the rawKey; for new bcrypt-only rows the
    // column on licenses is NULL, so fall back to the rawKey from the request.
    // Either way the value matches what /validate would write for the same key.
    const activationKey = license.license_key ?? rawKey;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Re-read onboarded_at under row lock so two concurrent /account/create
      // calls for the same license cannot both pass the "not yet onboarded"
      // gate. SELECT FOR UPDATE blocks the second caller until the first
      // commits, then the second sees onboarded_at set and 409s out.
      const { rows: gate } = await client.query(
        "SELECT onboarded_at FROM licenses WHERE id = $1 FOR UPDATE",
        [license.id]
      );
      if (gate[0]?.onboarded_at != null) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "account_already_exists",
          detail: "This license has already created an account. Use /account/connect instead.",
        });
      }

      await client.query(
        "UPDATE licenses SET account_name = $1, onboarded_at = NOW() WHERE id = $2",
        [account_name?.trim() || null, license.id]
      );

      await client.query(
        `INSERT INTO stations (uuid, license_key_id, name, nickname, frequency, call_letters)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          stationUuid,
          license.id,
          station.name.trim(),
          station.nickname?.trim() || null,
          station.frequency?.trim() || null,
          station.call_letters?.trim() || null,
        ]
      );

      // Seat upsert — same ON CONFLICT shape as the /validate path, plus
      // station_uuid binding. Re-onboarding a previously deauthorized seat
      // (deauthorized_at IS NOT NULL) clears that marker and rebinds it.
      await client.query(
        `INSERT INTO license_activations
           (license_key, machine_id, machine_name, ip_address, station_uuid)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (license_key, machine_id) DO UPDATE SET
           machine_name    = EXCLUDED.machine_name,
           ip_address      = EXCLUDED.ip_address,
           station_uuid    = EXCLUDED.station_uuid,
           last_seen       = NOW(),
           deauthorized_at = NULL`,
        [activationKey, machine_id.trim(), machine_name || null, ip, stationUuid]
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    console.log(`[Account/Create] license:${license.id} station:${stationUuid.slice(0, 8)} (${station.name.trim()})`);
    // plan included so OnboardingFlow can write plan_tier to local KV during onboarding;
    // fixes the gap where freshly-onboarded customers defaulted to free until they later
    // ran the SubscriptionPanel /validate flow.
    res.json({
      account_name: account_name?.trim() || null,
      station_uuid: stationUuid,
      plan:         license.plan ?? "free",
    });
  } catch (e) {
    console.error("[/account/create]", e.message);
    res.status(500).json({ error: "internal", detail: e.message });
  }
});

// POST /account/connect — "Connect to existing account" path (Screen 2b).
// Read-only: validates the license, counts active seats, and returns the
// account label + station list so the client can render Screen 3. Does NOT
// touch license_activations — the actual seat binding happens in
// /account/bind-seat once the customer picks a station.

app.post("/account/connect", async (req, res) => {
  try {
    const { license_key, machine_id, machine_name } = req.body || {};
    const rawKey = license_key?.trim();

    if (!rawKey || !machine_id?.trim()) {
      return res.status(400).json({
        error: "missing_fields",
        detail: "license_key and machine_id are required",
      });
    }

    const license = await lookupLicense(rawKey);
    if (!license) return res.status(401).json({ error: "invalid_license_key" });

    // license_activations.license_key fallback — see EB1 in close-out-tracker.
    const activationKey = license.license_key ?? rawKey;

    // Is this machine already an active seat? If so, it doesn't consume a slot
    // even when the license is at its seat cap.
    const { rows: alreadySeated } = await pool.query(
      "SELECT 1 FROM license_activations WHERE license_key=$1 AND machine_id=$2 AND deauthorized_at IS NULL",
      [activationKey, machine_id.trim()]
    );

    // Count active seats and pull the full list in one shot — the list is
    // returned either way (in seat_limit_reached responses for Manage Devices,
    // or implicitly available if the client wants it via /account/seats).
    const { rows: activeSeats } = await pool.query(
      "SELECT machine_id, machine_name, os, ip_address, activated_at, last_seen, station_uuid FROM license_activations WHERE license_key=$1 AND deauthorized_at IS NULL ORDER BY last_seen DESC",
      [activationKey]
    );
    const seatsUsed = activeSeats.length;

    if (seatsUsed >= SEATS_MAX && alreadySeated.length === 0) {
      console.log(`[Account/Connect] license:${license.id} machine:${machine_id.slice(0, 8)} ${machine_name ? `(${machine_name}) ` : ""}seat_limit_reached (${seatsUsed}/${SEATS_MAX})`);
      return res.status(403).json({
        error: "seat_limit_reached",
        seats: activeSeats,
        seats_used: seatsUsed,
        seats_max: SEATS_MAX,
      });
    }

    const { rows: stations } = await pool.query(
      "SELECT uuid, name, nickname, frequency, call_letters FROM stations WHERE license_key_id=$1 ORDER BY created_at ASC",
      [license.id]
    );

    console.log(`[Account/Connect] license:${license.id} machine:${machine_id.slice(0, 8)} ${machine_name ? `(${machine_name}) ` : ""}stations:${stations.length} seats:${seatsUsed}/${SEATS_MAX}`);
    // plan included so OnboardingFlow can write plan_tier to local KV during onboarding;
    // fixes the gap where freshly-onboarded customers defaulted to free until they later
    // ran the SubscriptionPanel /validate flow.
    res.json({
      account_name: license.account_name ?? null,
      stations,
      seats_used: seatsUsed,
      seats_max:  SEATS_MAX,
      plan:       license.plan ?? "free",
    });
  } catch (e) {
    console.error("[/account/connect]", e.message);
    res.status(500).json({ error: "internal", detail: e.message });
  }
});

// POST /account/bind-seat — bind the calling machine to a station (Screen 3).
// Transactional: locks the licenses row to serialize concurrent seat changes,
// verifies the station belongs to this license, defensively re-checks the
// seat limit if this would consume a new slot, then upserts the activation
// row. The limit check is defense-in-depth — /account/connect is the primary
// gate but a misbehaving client could call bind-seat directly.

app.post("/account/bind-seat", async (req, res) => {
  try {
    const { license_key, machine_id, machine_name, station_uuid } = req.body || {};
    const rawKey = license_key?.trim();

    if (!rawKey || !machine_id?.trim() || !station_uuid?.trim()) {
      return res.status(400).json({
        error: "missing_fields",
        detail: "license_key, machine_id, and station_uuid are required",
      });
    }

    const license = await lookupLicense(rawKey);
    if (!license) return res.status(401).json({ error: "invalid_license_key" });

    const activationKey = license.license_key ?? rawKey;
    const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "").trim();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Lock the licenses row so two concurrent bind-seat / create calls for
      // the same license serialize on the seat-count check below.
      await client.query("SELECT 1 FROM licenses WHERE id=$1 FOR UPDATE", [license.id]);

      // Station must exist AND belong to this license. A bare FK violation
      // (station_uuid not in stations.uuid at all) would surface as 500, so
      // pre-check it cleanly here.
      const { rows: station } = await client.query(
        "SELECT 1 FROM stations WHERE uuid=$1 AND license_key_id=$2",
        [station_uuid.trim(), license.id]
      );
      if (!station.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "station_not_found",
          detail: "station_uuid does not exist under this license",
        });
      }

      // Defensive seat-limit check: only matters if this call would create a
      // new active seat (no row yet, or row exists but is deauthorized). An
      // already-active seat just rebinding to a different station does not
      // consume a slot.
      const { rows: existing } = await client.query(
        "SELECT deauthorized_at FROM license_activations WHERE license_key=$1 AND machine_id=$2",
        [activationKey, machine_id.trim()]
      );
      const willConsumeSlot = existing.length === 0 || existing[0].deauthorized_at != null;
      if (willConsumeSlot) {
        const { rows: countRow } = await client.query(
          "SELECT COUNT(*)::int AS n FROM license_activations WHERE license_key=$1 AND deauthorized_at IS NULL",
          [activationKey]
        );
        if (countRow[0].n >= SEATS_MAX) {
          await client.query("ROLLBACK");
          return res.status(403).json({
            error: "seat_limit_reached",
            seats_used: countRow[0].n,
            seats_max: SEATS_MAX,
          });
        }
      }

      await client.query(
        `INSERT INTO license_activations
           (license_key, machine_id, machine_name, ip_address, station_uuid)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (license_key, machine_id) DO UPDATE SET
           machine_name    = EXCLUDED.machine_name,
           ip_address      = EXCLUDED.ip_address,
           station_uuid    = EXCLUDED.station_uuid,
           last_seen       = NOW(),
           deauthorized_at = NULL`,
        [activationKey, machine_id.trim(), machine_name || null, ip, station_uuid.trim()]
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    console.log(`[Account/BindSeat] license:${license.id} machine:${machine_id.slice(0, 8)} station:${station_uuid.trim().slice(0, 8)}`);
    res.json({ ok: true });
  } catch (e) {
    console.error("[/account/bind-seat]", e.message);
    res.status(500).json({ error: "internal", detail: e.message });
  }
});

// POST /account/add-station — Screen 3b "Add a new station" action.
// Called after /account/connect when the customer picks "Add a new station"
// instead of an existing one. Creates the stations row and binds this
// machine's seat to it in one transaction.
//
// Same transaction + seat-limit pattern as /account/bind-seat: the limit
// check is belt-and-suspenders here because /account/connect already gated
// on it, but a buggy/misordered client could call this directly.

app.post("/account/add-station", async (req, res) => {
  try {
    const { license_key, machine_id, machine_name, station } = req.body || {};
    const rawKey = license_key?.trim();

    if (!rawKey || !machine_id?.trim() || !station?.name?.trim()) {
      return res.status(400).json({
        error: "missing_fields",
        detail: "license_key, machine_id, and station.name are required",
      });
    }

    const license = await lookupLicense(rawKey);
    if (!license) return res.status(401).json({ error: "invalid_license_key" });

    const stationUuid = crypto.randomUUID();
    const activationKey = license.license_key ?? rawKey;
    const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "").trim();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Serialize concurrent seat-mutating ops for this license (same lock
      // pattern as /account/create and /account/bind-seat).
      await client.query("SELECT 1 FROM licenses WHERE id=$1 FOR UPDATE", [license.id]);

      // Station-count cap (EB2). Per-plan limits enforced AFTER the row lock
      // so two concurrent /account/add-station calls for the same license
      // can't both pass a stale count check. operator → -1 short-circuits
      // before the COUNT query. Unknown plan values fall through to the
      // strictest (free) cap — defense in depth against any licenses.plan
      // row that escaped EB4's /admin/issue validation. Listed BEFORE the
      // seat-limit check so the more informative station_limit_reached
      // fires first if a customer would hit both.
      const stationCap = PLAN_STATION_LIMITS[license.plan] ?? PLAN_STATION_LIMITS.free;
      if (stationCap !== -1) {
        const { rows: scRow } = await client.query(
          "SELECT COUNT(*)::int AS n FROM stations WHERE license_key_id=$1",
          [license.id]
        );
        if (scRow[0].n >= stationCap) {
          await client.query("ROLLBACK");
          return res.status(403).json({
            error: "station_limit_reached",
            stations_used: scRow[0].n,
            stations_max: stationCap,
            plan: license.plan,
          });
        }
      }

      // Defensive seat-limit check — only fires when this call would consume
      // a new slot. /account/connect already gated the customer here in the
      // normal flow; this catches direct/misordered clients.
      const { rows: existing } = await client.query(
        "SELECT deauthorized_at FROM license_activations WHERE license_key=$1 AND machine_id=$2",
        [activationKey, machine_id.trim()]
      );
      const willConsumeSlot = existing.length === 0 || existing[0].deauthorized_at != null;
      if (willConsumeSlot) {
        const { rows: countRow } = await client.query(
          "SELECT COUNT(*)::int AS n FROM license_activations WHERE license_key=$1 AND deauthorized_at IS NULL",
          [activationKey]
        );
        if (countRow[0].n >= SEATS_MAX) {
          await client.query("ROLLBACK");
          return res.status(403).json({
            error: "seat_limit_reached",
            seats_used: countRow[0].n,
            seats_max: SEATS_MAX,
          });
        }
      }

      await client.query(
        `INSERT INTO stations (uuid, license_key_id, name, nickname, frequency, call_letters)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          stationUuid,
          license.id,
          station.name.trim(),
          station.nickname?.trim() || null,
          station.frequency?.trim() || null,
          station.call_letters?.trim() || null,
        ]
      );

      // Belt-and-suspenders: if a buggy client somehow reaches add-station
      // without going through /account/create first, mark the license
      // onboarded anyway so a later /account/create call hits its 409 gate
      // rather than silently creating a second station. No-op in the normal
      // flow where /account/create already set onboarded_at.
      await client.query(
        "UPDATE licenses SET onboarded_at = NOW() WHERE id = $1 AND onboarded_at IS NULL",
        [license.id]
      );

      // Seat upsert binds this machine to the brand-new station. Same
      // ON CONFLICT shape as /account/create and /account/bind-seat.
      await client.query(
        `INSERT INTO license_activations
           (license_key, machine_id, machine_name, ip_address, station_uuid)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (license_key, machine_id) DO UPDATE SET
           machine_name    = EXCLUDED.machine_name,
           ip_address      = EXCLUDED.ip_address,
           station_uuid    = EXCLUDED.station_uuid,
           last_seen       = NOW(),
           deauthorized_at = NULL`,
        [activationKey, machine_id.trim(), machine_name || null, ip, stationUuid]
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    console.log(`[Account/AddStation] license:${license.id} machine:${machine_id.slice(0, 8)} station:${stationUuid.slice(0, 8)} (${station.name.trim()})`);
    res.json({ station_uuid: stationUuid });
  } catch (e) {
    console.error("[/account/add-station]", e.message);
    res.status(500).json({ error: "internal", detail: e.message });
  }
});

// POST /account/deauthorize-seat — soft-delete a seat (Manage Devices).
// Sets deauthorized_at = NOW() on the matching license_activations row.
// Idempotent: deauthorizing an already-deauthorized seat or a nonexistent
// row returns ok=true with removed=0. The UI is the gate against
// self-deauthorization ("Deauthorize" button absent on the current device).

app.post("/account/deauthorize-seat", async (req, res) => {
  try {
    const { license_key, machine_id } = req.body || {};
    const rawKey = license_key?.trim();

    if (!rawKey || !machine_id?.trim()) {
      return res.status(400).json({
        error: "missing_fields",
        detail: "license_key and machine_id are required",
      });
    }

    const license = await lookupLicense(rawKey);
    if (!license) return res.status(401).json({ error: "invalid_license_key" });

    const activationKey = license.license_key ?? rawKey;

    const { rowCount } = await pool.query(
      "UPDATE license_activations SET deauthorized_at = NOW() WHERE license_key = $1 AND machine_id = $2 AND deauthorized_at IS NULL",
      [activationKey, machine_id.trim()]
    );

    console.log(`[Account/Deauthorize] license:${license.id} machine:${machine_id.trim().slice(0, 8)} (deauthorized ${rowCount})`);
    res.json({ ok: true, removed: rowCount });
  } catch (e) {
    console.error("[/account/deauthorize-seat]", e.message);
    res.status(500).json({ error: "internal", detail: e.message });
  }
});

// GET /account/seats — list active seats for Manage Devices.
// Returns the same row shape as /licenses/:key/activations but under the
// /account namespace, license-key-only auth (no email match), and includes
// station_uuid + seat-cap counts so the panel can render "Devices: N/5".
// Auth via x-license-key header (not query param) so the key doesn't land
// in access logs, proxy logs, or browser history. Matches /api/cmd.

app.get("/account/seats", async (req, res) => {
  try {
    const rawKey = (req.headers["x-license-key"] || "").toString().trim();
    if (!rawKey) {
      return res.status(401).json({
        error: "missing_license_key",
        detail: "x-license-key header is required",
      });
    }

    const license = await lookupLicense(rawKey);
    if (!license) return res.status(401).json({ error: "invalid_license_key" });

    const activationKey = license.license_key ?? rawKey;

    const { rows: seats } = await pool.query(
      `SELECT machine_id, machine_name, os, ip_address, station_uuid,
              activated_at, last_seen
       FROM license_activations
       WHERE license_key = $1 AND deauthorized_at IS NULL
       ORDER BY last_seen DESC`,
      [activationKey]
    );

    res.json({
      seats,
      seats_used: seats.length,
      seats_max: SEATS_MAX,
    });
  } catch (e) {
    console.error("[/account/seats]", e.message);
    res.status(500).json({ error: "internal", detail: e.message });
  }
});

// ── Audio sync (R2 signed URLs) ───────────────────────────────
// Customers never hold R2 credentials. They POST { license_key, file_key }
// and receive a short-lived signed PUT URL scoped to ${license.id}/${file_key}.
// Customer-side flow (after Phase 1.3g lands in C:\openair):
//   1. POST /audio/upload-url → { signed_url, expires_at }
//   2. PUT the audio bytes directly to signed_url
//   3. On success, mark local songs.r2_uploaded_at + file_key
// Failure modes: 400 missing_fields / invalid_file_key,
//                401 invalid_license_key,
//                503 r2_not_configured,
//                500 signing_failed.

app.post("/audio/upload-url", async (req, res) => {
  try {
    const { license_key, file_key } = req.body || {};
    const rawKey = license_key?.trim();
    if (!rawKey) {
      return res.status(400).json({
        error:  "missing_fields",
        detail: "license_key is required",
      });
    }

    const sanitized = sanitizeFileKey(file_key);
    if (sanitized.error) {
      return res.status(400).json({ error: "invalid_file_key", detail: sanitized.error });
    }

    const license = await lookupLicense(rawKey);
    if (!license) return res.status(401).json({ error: "invalid_license_key" });

    if (!getR2Client()) {
      return res.status(503).json({
        error:  "r2_not_configured",
        detail: "Backend R2 credentials not set",
      });
    }

    const r2Key            = `${license.id}/${sanitized.value}`;
    const expiresInSeconds = 15 * 60;

    let signedUrl;
    try {
      signedUrl = await signR2PutUrl(r2Key, expiresInSeconds);
    } catch (e) {
      console.error("[/audio/upload-url] signing failed:", e.message);
      return res.status(500).json({ error: "signing_failed", detail: e.message });
    }

    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    console.log(`[Audio/UploadURL] license:${license.id} key:${sanitized.value} (15m)`);
    res.json({ signed_url: signedUrl, expires_at: expiresAt });
  } catch (e) {
    console.error("[/audio/upload-url]", e.message);
    res.status(500).json({ error: "internal", detail: e.message });
  }
});

// POST /audio/download-url — license-validated signed GET URL.
// Same body / response / error shapes as /audio/upload-url. Customer flow
// (after Phase 1.3i lands in C:\openair):
//   1. POST { license_key, file_key } → { signed_url, expires_at }
//   2. fetch GET signed_url → audio bytes
//   3. Save to local audio cache (userData/audio-cache/<file_key>)
//
// NB: object-not-found is NOT checked here. If file_key doesn't exist in R2
// for this license's prefix, this endpoint still returns 200 with a valid
// signed URL — the customer's subsequent GET on that URL hits R2's own 404.
// Saves an extra HeadObject roundtrip per signing call. Customer-side caller
// must distinguish backend errors (4xx/5xx JSON from this endpoint) from R2
// errors (XML body from the signed URL GET).

app.post("/audio/download-url", async (req, res) => {
  try {
    const { license_key, file_key } = req.body || {};
    const rawKey = license_key?.trim();
    if (!rawKey) {
      return res.status(400).json({
        error:  "missing_fields",
        detail: "license_key is required",
      });
    }

    const sanitized = sanitizeFileKey(file_key);
    if (sanitized.error) {
      return res.status(400).json({ error: "invalid_file_key", detail: sanitized.error });
    }

    const license = await lookupLicense(rawKey);
    if (!license) return res.status(401).json({ error: "invalid_license_key" });

    if (!getR2Client()) {
      return res.status(503).json({
        error:  "r2_not_configured",
        detail: "Backend R2 credentials not set",
      });
    }

    const r2Key            = `${license.id}/${sanitized.value}`;
    const expiresInSeconds = 15 * 60;

    let signedUrl;
    try {
      signedUrl = await signR2GetUrl(r2Key, expiresInSeconds);
    } catch (e) {
      console.error("[/audio/download-url] signing failed:", e.message);
      return res.status(500).json({ error: "signing_failed", detail: e.message });
    }

    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    console.log(`[Audio/DownloadURL] license:${license.id} key:${sanitized.value} (15m)`);
    res.json({ signed_url: signedUrl, expires_at: expiresAt });
  } catch (e) {
    console.error("[/audio/download-url]", e.message);
    res.status(500).json({ error: "internal", detail: e.message });
  }
});

// GET /audio/list — every R2 key under the customer's license prefix.
// Auth: x-license-key header (matches /account/seats pattern — GET endpoints
// take credentials in the header rather than the body).
// Customer flow (Onboarding "From the cloud" path, Phase 3.4):
//   1. GET /audio/list (header) → { keys: [...] }
//   2. For each key, POST /audio/download-url → signed URL
//   3. Fetch + cache
//
// Keys are returned WITHOUT the ${license.id}/ prefix so the customer never
// sees their internal license_key_id. Server-side pagination loops through
// ContinuationToken until exhausted; see the ~10k-key practical ceiling
// caveat on listR2ObjectsForPrefix.

app.get("/audio/list", async (req, res) => {
  try {
    const rawKey = (req.headers["x-license-key"] || "").toString().trim();
    if (!rawKey) {
      return res.status(401).json({
        error:  "missing_license_key",
        detail: "x-license-key header is required",
      });
    }

    const license = await lookupLicense(rawKey);
    if (!license) return res.status(401).json({ error: "invalid_license_key" });

    if (!getR2Client()) {
      return res.status(503).json({
        error:  "r2_not_configured",
        detail: "Backend R2 credentials not set",
      });
    }

    const prefix = `${license.id}/`;
    let allKeys;
    try {
      allKeys = await listR2ObjectsForPrefix(prefix);
    } catch (e) {
      console.error("[/audio/list] listing failed:", e.message);
      return res.status(500).json({ error: "listing_failed", detail: e.message });
    }

    // Strip the license prefix so customers never see their internal
    // license_key_id. R2 enforces Prefix on ListObjectsV2, so every key
    // returned should already start with `${license.id}/` — the defensive
    // startsWith check costs nothing and surfaces a clear bug if it doesn't.
    const keys = allKeys
      .filter(k => k.startsWith(prefix))
      .map(k => k.slice(prefix.length));

    console.log(`[Audio/List] license:${license.id} keys:${keys.length}`);
    res.json({ keys });
  } catch (e) {
    console.error("[/audio/list]", e.message);
    res.status(500).json({ error: "internal", detail: e.message });
  }
});

// ── DB backups (R2 signed URLs) ───────────────────────────────
// POST /backup/upload-url — signs BOTH the gzipped-DB key and the metadata
// sidecar key in one shot. Atomic at the signing layer: either both URLs
// come back valid or the endpoint 500s and the customer retries the pair.
// Future sidecar additions (e.g. .checksum) slot in as another signed URL
// in the same response — no client coordination required.
//
// Customer flow (Phase 1.3f rewrite of cloud-backup.js):
//   1. cloud-backup.js wakes on its 6h timer
//   2. Gzip openair.db; build metadata JSON (station_name, table counts, etc.)
//   3. Generate timestamp via toISOString().replace(/[:.]/g, '-').slice(0,19)
//      — filename-safe form, no colons
//   4. POST { license_key, timestamp } → { db_signed_url, meta_signed_url, expires_at }
//   5. PUT gzipped DB to db_signed_url   (Content-Type: application/gzip)
//   6. PUT meta JSON to meta_signed_url  (Content-Type: application/json)
//   7. History row counts as success only if BOTH PUTs succeed; partial
//      success is recorded as "incomplete_backup" with the failed half
//
// Key construction:
//   ${license.id}/backups/${timestamp}.db.gz
//   ${license.id}/backups/${timestamp}.meta.json
//
// timestamp is client-supplied (no arbitrary file_key here — backup naming
// is server-controlled to keep the listing structure predictable). Validated
// against /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z?$/.

app.post("/backup/upload-url", async (req, res) => {
  try {
    const { license_key, timestamp } = req.body || {};
    const rawKey = license_key?.trim();
    if (!rawKey || !timestamp) {
      return res.status(400).json({
        error:  "missing_fields",
        detail: "license_key and timestamp are required",
      });
    }

    const sanitized = sanitizeBackupTimestamp(timestamp);
    if (sanitized.error) {
      return res.status(400).json({ error: "invalid_timestamp", detail: sanitized.error });
    }

    const license = await lookupLicense(rawKey);
    if (!license) return res.status(401).json({ error: "invalid_license_key" });

    if (!getR2Client()) {
      return res.status(503).json({
        error:  "r2_not_configured",
        detail: "Backend R2 credentials not set",
      });
    }

    const dbKey            = `${license.id}/backups/${sanitized.value}.db.gz`;
    const metaKey          = `${license.id}/backups/${sanitized.value}.meta.json`;
    const expiresInSeconds = 15 * 60;

    let dbSignedUrl, metaSignedUrl;
    try {
      // Sign both in parallel. Either both succeed and the customer gets a
      // matched pair, or one throws and the endpoint 500s — the customer
      // never sees half-state.
      [dbSignedUrl, metaSignedUrl] = await Promise.all([
        signR2PutUrl(dbKey,   expiresInSeconds),
        signR2PutUrl(metaKey, expiresInSeconds),
      ]);
    } catch (e) {
      console.error("[/backup/upload-url] signing failed:", e.message);
      return res.status(500).json({ error: "signing_failed", detail: e.message });
    }

    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    console.log(`[Backup/UploadURL] license:${license.id} ts:${sanitized.value} (db+meta, 15m)`);
    res.json({
      db_signed_url:   dbSignedUrl,
      meta_signed_url: metaSignedUrl,
      expires_at:      expiresAt,
    });
  } catch (e) {
    console.error("[/backup/upload-url]", e.message);
    res.status(500).json({ error: "internal", detail: e.message });
  }
});

// POST /backup/download-url — signs a GET URL for the account's LATEST gzipped DB
// backup. Mirror of /backup/upload-url. Used by a NEW install to restore the full
// openair.db from the cloud (install a station from your account).
//
//   POST { license_key } → { db_signed_url, key, timestamp, expires_at }
//
// Backups live at ${license.id}/backups/${timestamp}.db.gz — the timestamp names
// sort lexically = chronologically, so the max key is the newest backup.
app.post("/backup/download-url", async (req, res) => {
  try {
    const rawKey = (req.body || {}).license_key?.trim();
    if (!rawKey) return res.status(400).json({ error: "missing_fields", detail: "license_key is required" });

    const license = await lookupLicense(rawKey);
    if (!license) return res.status(401).json({ error: "invalid_license_key" });

    const r2 = getR2Client();
    if (!r2) return res.status(503).json({ error: "r2_not_configured", detail: "Backend R2 credentials not set" });

    const { ListObjectsV2Command } = require("@aws-sdk/client-s3");
    const prefix = `${license.id}/backups/`;
    const listed = await r2.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix }));
    const dbKeys = (listed.Contents || []).map(o => o.Key).filter(k => k.endsWith(".db.gz")).sort();
    if (dbKeys.length === 0) {
      return res.status(404).json({ error: "no_backup", detail: "No DB backup found for this account" });
    }
    const latestKey = dbKeys[dbKeys.length - 1];
    const timestamp = latestKey.slice(prefix.length, -".db.gz".length);
    const expiresInSeconds = 15 * 60;

    let dbSignedUrl;
    try { dbSignedUrl = await signR2GetUrl(latestKey, expiresInSeconds); }
    catch (e) {
      console.error("[/backup/download-url] signing failed:", e.message);
      return res.status(500).json({ error: "signing_failed", detail: e.message });
    }

    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    console.log(`[Backup/DownloadURL] license:${license.id} key:${latestKey} (15m)`);
    res.json({ db_signed_url: dbSignedUrl, key: latestKey, timestamp, expires_at: expiresAt });
  } catch (e) {
    console.error("[/backup/download-url]", e.message);
    res.status(500).json({ error: "internal", detail: e.message });
  }
});

// POST /account/devices — list the machines (seats) registered to this account, for the
// Multi-Device Sync clarity panel. Each row: machine_id, machine_name, os, activated_at,
// last_seen. The desktop marks which one is "this machine" by machine_id (= client_id).
app.post("/account/devices", async (req, res) => {
  try {
    const rawKey = (req.body || {}).license_key?.trim();
    if (!rawKey) return res.status(400).json({ error: "missing_fields", detail: "license_key is required" });
    const license = await lookupLicense(rawKey);
    if (!license) return res.status(401).json({ error: "invalid_license_key" });
    // Multi-Device Sync is Network-tier only.
    if (!["station", "station_lifetime", "operator"].includes(license.plan)) {
      return res.status(403).json({ error: "network_plan_required", detail: "Multi-Device Sync requires the Network plan." });
    }
    const activationKey = license.license_key || `lic-${license.id}`;
    const { rows } = await pool.query(
      `SELECT machine_id, machine_name, os, activated_at, last_seen
         FROM license_activations
        WHERE license_key = $1 AND deauthorized_at IS NULL
        ORDER BY last_seen DESC`, [activationKey]
    );
    const limit = PLAN_MACHINE_LIMITS[license.plan] ?? 1;
    res.json({ devices: rows, limit, plan: license.plan });
  } catch (e) {
    console.error("[/account/devices]", e.message);
    res.status(500).json({ error: "internal", detail: e.message });
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
  if (!VALID_PLANS.has(plan)) {
    return res.status(400).json({
      error: "invalid_plan",
      detail: `plan must be one of: ${[...VALID_PLANS].join(", ")}`,
    });
  }
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

  // Account-linked subscription (from the signup app's /api/user/checkout): the session carries the
  // user id (client_reference_id) + chosen plan (metadata). Create/activate the license and link it
  // to that account so its entitlement flips to paid. No key email — the customer uses email+password.
  if (event.type === "checkout.session.completed" && event.data.object.client_reference_id) {
    const s = event.data.object;
    const userId = parseInt(s.client_reference_id, 10);
    const email  = (s.customer_details?.email || s.customer_email || "").toLowerCase().trim();
    const plan   = s.metadata?.plan;
    const subId  = s.subscription || s.id;
    if (userId && plan && VALID_PLANS.has(plan)) {
      const { rows: existing } = await pool.query("SELECT id FROM licenses WHERE stripe_sub_id=$1", [subId]);
      let licId;
      if (existing.length) {
        await pool.query("UPDATE licenses SET active=true, plan=$1, email=$2 WHERE id=$3", [plan, email || null, existing[0].id]);
        licId = existing[0].id;
      } else {
        const key = generateLicenseKey(plan);
        const r = await pool.query(
          "INSERT INTO licenses (email,plan,stripe_sub_id,key_prefix,key_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id",
          [email || null, plan, subId, key.slice(0, 12), await bcrypt.hash(key, 12)]
        );
        licId = r.rows[0].id;
      }
      await pool.query("UPDATE users SET license_key_id=$1 WHERE id=$2", [licId, userId]);
      console.log(`[Stripe] account subscription: user ${userId} → license ${licId} (${plan})`);
    } else {
      console.warn(`[Stripe] account checkout missing userId/plan (ref=${s.client_reference_id}, plan=${plan})`);
    }
    return res.json({ received: true });
  }

  if (["checkout.session.completed","invoice.payment_succeeded"].includes(event.type)) {
    const obj   = event.data.object;
    const email = (obj.customer_email || obj.customer_details?.email || "").toLowerCase().trim();
    const subId = obj.subscription || obj.id;
    if (!email) { console.warn("[Stripe] No email"); return res.json({ received: true }); }

    const items   = obj.lines?.data || [];
    const priceId = items[0]?.price?.id || "";
    const plan    = PLAN_BY_PRICE_ID[priceId];
    if (!plan) {
      // EB3: was a silent fallback to "pro". Now unknown priceIds — empty
      // string from a malformed event, a new Stripe product without a
      // matching env var, or anything else — fail loudly. Ack to Stripe so
      // it doesn't retry indefinitely, but issue no license. Operator must
      // notice the log and issue manually via /admin/issue. See also EB12.
      console.error(
        `[Stripe] UNKNOWN priceId "${priceId}" for ${email} ` +
        `(event: ${event.type}, subId: ${subId}) — no license issued. ` +
        `Acknowledging webhook to prevent retry. Operator must issue manually.`
      );
      return res.json({ received: true });
    }

    const { rows: existing } = await pool.query("SELECT * FROM licenses WHERE stripe_sub_id=$1", [subId]);
    let licenseKey;
    if (existing.length) {
      await pool.query("UPDATE licenses SET active=true, email=$1 WHERE id=$2", [email, existing[0].id]);
      licenseKey = existing[0].license_key;
      console.log(`[License] Reactivated: ${licenseKey} → ${email}`);
    } else {
      licenseKey = generateLicenseKey(plan);
      const keyPrefix = licenseKey.slice(0, 12);
      const keyHash   = await bcrypt.hash(licenseKey, 12); // computed before BEGIN — keeps tx window short
      // Transaction: if email throws, INSERT is rolled back so Stripe retries a clean slate.
      // On retry: no existing row → fresh key generated → new email attempt.
      const txClient = await pool.connect();
      try {
        await txClient.query('BEGIN');
        await txClient.query(
          "INSERT INTO licenses (email,plan,stripe_sub_id,key_prefix,key_hash) VALUES ($1,$2,$3,$4,$5)",
          [email, plan, subId, keyPrefix, keyHash]
        );
        await sendLicenseEmail(email, licenseKey, plan);
        await txClient.query('COMMIT');
        console.log(`[License] Issued: ${keyPrefix}... → ${email} (${plan})`);
      } catch (e) {
        await txClient.query('ROLLBACK').catch(() => {});
        console.error('[License] Issue+email failed, rolled back:', e.message);
        throw e;  // non-2xx → Stripe retries with exponential backoff
      } finally {
        txClient.release();
      }
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

// Resolve the license + station_uuid the desktop app sends and upsert the live
// per-station now-playing row (Listener Platform / Control Center foundation).
// Keyed on (license_key_id, station_uuid): if the uuid isn't a backend-known
// station for this license (e.g. a local-only, never-onboarded station), skip
// silently — the global slot has already been served. Best-effort by design.
async function upsertStationNowPlaying(rawKey, body) {
  if (!rawKey || !body || !body.station_uuid) return;
  const license = await lookupLicense(rawKey);
  if (!license) return;
  const { rows } = await pool.query(
    `SELECT uuid FROM stations WHERE uuid = $1 AND license_key_id = $2`,
    [body.station_uuid, license.id]
  );
  if (rows.length === 0) return; // not a known station for this license — skip

  const playing  = !!body.playing;
  // position_sec/duration_sec are INTEGER columns, but the desktop sends
  // fractional seconds (the engine interpolates position between polls). An
  // unrounded float makes Postgres reject the whole row ("invalid input syntax
  // for type integer"), and the upsert's caller swallows the error — which
  // silently dropped EVERY playing=true report (those carry non-zero, fractional
  // position/duration), leaving the row stuck on the last playing=false post.
  // Round to whole seconds so the row actually persists.
  const position = Math.round(Number(body.position)) || 0;
  const duration = Math.round(Number(body.duration)) || 0;
  // started_at lets listeners compute elapsed locally without per-second updates.
  const startedAt = playing ? new Date(Date.now() - position * 1000) : null;

  const decksJson = body.decks && typeof body.decks === "object" ? JSON.stringify(body.decks) : null;

  await pool.query(
    `INSERT INTO station_now_playing
       (station_uuid, playing, title, artist, deck, started_at, position_sec, duration_sec, queue, art_url, decks, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
     ON CONFLICT (station_uuid) DO UPDATE SET
       playing=$2, title=$3, artist=$4, deck=$5, started_at=$6,
       position_sec=$7, duration_sec=$8, queue=$9, art_url=$10, decks=$11, updated_at=NOW()`,
    [
      body.station_uuid, playing, body.title ?? null, body.artist ?? null,
      body.deck ?? null, startedAt, position, duration,
      JSON.stringify(Array.isArray(body.queue) ? body.queue : []),
      body.art_url ?? null, decksJson,
    ]
  );

  // Broadcast to public listeners (Phase 3) — only if this station has a
  // published public slug. now-playing-only per the Phase 3 decision. Wrapped
  // so a broadcast failure never propagates (the upsert above already succeeded).
  try {
    const { rows: meta } = await pool.query(
      `SELECT slug FROM station_metadata WHERE station_uuid = $1 AND public_enabled = true AND slug IS NOT NULL`,
      [body.station_uuid]
    );
    if (meta.length) {
      broadcastNowPlaying(meta[0].slug, {
        playing, title: body.title ?? null, artist: body.artist ?? null,
        deck: body.deck ?? null, decks: body.decks ?? null,
        started_at: startedAt, duration_sec: duration, art_url: body.art_url ?? null,
        queue: Array.isArray(body.queue) ? body.queue : [], updated_at: Date.now(),
      });
    }
  } catch (e) {
    console.warn("[now-playing] broadcast skipped:", e.message);
  }
}

app.post("/api/now-playing", async (req, res) => {
  // Global slot — unchanged, unconditional, FIRST. OV's /mobile, /dashboard and
  // /console read this; it must never regress. Respond immediately.
  nowPlaying.data = { ...req.body, updated_at: Date.now() };
  res.json({ ok: true });

  // Per-station upsert runs AFTER the response, fully wrapped — a failure here
  // can never affect the response above or the global slot OV depends on.
  try {
    await upsertStationNowPlaying(req.headers["x-license-key"], req.body);
  } catch (e) {
    console.warn("[now-playing] per-station upsert skipped:", e.message);
  }
});

app.get("/api/now-playing", (req, res) => {
  res.json(nowPlaying.data || { playing: false, title: null, artist: null, position: 0, duration: 0, queue: [], history: [] });
});

// ── Public listener endpoints (Phase 3) ───────────────────────────────────
// Unauthenticated; global cors({origin:"*"}) (index.js top) covers CORS. These
// power the listener PWA: a combined metadata + now-playing read, and an SSE
// stream that pushes now-playing on each song change.

// Write a now-playing event to every listener subscribed to a slug's stream.
function broadcastNowPlaying(slug, payload) {
  const clients = streamClients.get(slug);
  if (!clients || clients.size === 0) return;
  const frame = `event: now-playing\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) { if (!res.writableEnded) res.write(frame); }
}

// Public directory — every published station across ALL accounts, for the
// SiriusXM-style discovery page + player. `live` = pushing now-playing within
// the last 5 min (a stale row means the station stopped). Live stations sort
// first. Unauthenticated; a station appears here the moment its public page is
// enabled and it goes on air.
app.get("/public/stations", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.slug, m.display_name, m.logo_url, m.color_primary, m.color_secondary,
              m.description, m.category, m.stream_url,
              n.title, n.artist, n.art_url,
              (n.playing = true AND n.updated_at > NOW() - INTERVAL '5 minutes') AS live
       FROM station_metadata m
       LEFT JOIN station_now_playing n ON n.station_uuid = m.station_uuid
       WHERE m.public_enabled = true AND m.slug IS NOT NULL
       ORDER BY (n.playing = true AND n.updated_at > NOW() - INTERVAL '5 minutes') DESC,
                COALESCE(m.display_name, m.slug) ASC`
    );
    res.json({
      stations: rows.map(r => ({
        slug: r.slug,
        display_name: r.display_name || r.slug,
        logo_url: r.logo_url || null,
        color_primary: r.color_primary || null,
        color_secondary: r.color_secondary || null,
        description: r.description || null,
        category: r.category || null,
        stream_url: r.stream_url || null,
        live: !!r.live,
        now_playing: r.live ? { title: r.title, artist: r.artist, art_url: r.art_url || null } : null,
      })),
    });
  } catch (e) {
    console.error("[public/stations]", e.message);
    res.status(500).json({ error: "server_error" });
  }
});

// Combined metadata + now-playing for a public station. 404 if the slug is
// unknown or the page isn't published; 301 to the current slug if it's an old
// (renamed) slug that now points at a published station.
app.get("/public/station/:slug", async (req, res) => {
  const slug = String(req.params.slug || "").toLowerCase();
  try {
    const { rows } = await pool.query(
      `SELECT m.slug, m.display_name, m.logo_url, m.color_primary, m.color_secondary,
              m.description, m.socials, m.public_enabled, m.stream_url,
              n.playing, n.title, n.artist, n.deck, n.decks, n.started_at, n.duration_sec, n.queue, n.art_url, n.updated_at
       FROM station_metadata m
       LEFT JOIN station_now_playing n ON n.station_uuid = m.station_uuid
       WHERE m.slug = $1`,
      [slug]
    );
    if (rows.length && rows[0].public_enabled) {
      const r = rows[0];
      return res.json({
        slug: r.slug,
        display_name: r.display_name,
        logo_url: r.logo_url,
        color_primary: r.color_primary,
        color_secondary: r.color_secondary,
        description: r.description,
        socials: r.socials || {},
        stream_url: r.stream_url || null,
        now_playing: r.updated_at ? {
          playing: r.playing, title: r.title, artist: r.artist, deck: r.deck, decks: r.decks || null,
          started_at: r.started_at, duration_sec: r.duration_sec, art_url: r.art_url || null,
          queue: r.queue || [], updated_at: r.updated_at,
        } : null,
      });
    }
    // Not a current public slug — if it's a renamed-away slug, 301 to the new one.
    const { rows: hist } = await pool.query(
      `SELECT m.slug FROM station_slug_history h
       JOIN station_metadata m ON m.station_uuid = h.station_uuid
       WHERE h.old_slug = $1 AND m.public_enabled = true AND m.slug IS NOT NULL`,
      [slug]
    );
    if (hist.length && hist[0].slug && hist[0].slug !== slug) {
      return res.redirect(301, `/public/station/${hist[0].slug}`);
    }
    return res.status(404).json({ error: "not_found" });
  } catch (e) {
    console.error("[public/station]", e.message);
    res.status(500).json({ error: "server_error" });
  }
});

// SSE stream of now-playing for a public station. Mirrors /api/cmd-stream:
// 15s keepalive, X-Accel-Buffering:no for Railway/nginx. Only current published
// slugs get a stream; old/renamed slugs 404 (the client re-GETs to rediscover).
app.get("/public/station/:slug/stream", async (req, res) => {
  const slug = String(req.params.slug || "").toLowerCase();
  let stationUuid = null;
  try {
    const { rows } = await pool.query(
      `SELECT station_uuid FROM station_metadata WHERE slug = $1 AND public_enabled = true LIMIT 1`,
      [slug]
    );
    if (rows.length === 0) return res.status(404).json({ error: "not_found" });
    stationUuid = rows[0].station_uuid;
  } catch (e) {
    console.error("[public/stream]", e.message);
    return res.status(500).json({ error: "server_error" });
  }

  res.set({
    "Content-Type":      "text/event-stream",
    "Cache-Control":     "no-cache",
    "X-Accel-Buffering": "no",   // disable Railway/Nginx proxy buffering
    "Connection":        "keep-alive",
  });
  res.flushHeaders();

  // Cloudflare-derived visitor country (2-letter), reported by the listener page for
  // the dashboard's listeners-by-country map. Best-effort; "" if unknown.
  res._cc = String(req.query.cc || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
  // Cloudflare-derived region/state (e.g. "Texas"), reported by the listener page for the
  // dashboard's "Top states / regions" breakdown. Best-effort; "" if unknown.
  res._region = String(req.query.region || "").trim().slice(0, 60);
  // City + an anonymous, browser-generated listener id (no PII) for unique-listener counts +
  // the per-session log written on disconnect.
  res._city = String(req.query.city || "").trim().slice(0, 80);
  res._lid = String(req.query.lid || "").trim().slice(0, 40);
  res._stationUuid = stationUuid;
  res._connectedAt = Date.now();
  if (!streamClients.has(slug)) streamClients.set(slug, new Set());
  const clients = streamClients.get(slug);
  clients.add(res);
  console.log(`[public-stream] connected — slug=${slug} cc=${res._cc || "?"} streams=${clients.size}`);

  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, 15_000);

  res.on("close", () => {
    clearInterval(keepalive);
    clients.delete(res);
    if (clients.size === 0) streamClients.delete(slug);
    // Log the completed listening session (powers the audience report: TLH, duration, tune-in, geo).
    if (res._stationUuid) {
      const durationSec = Math.max(0, Math.round((Date.now() - (res._connectedAt || Date.now())) / 1000));
      pool.query(
        `INSERT INTO listener_sessions (station_uuid, started_at, ended_at, duration_sec, cc, region, city, lid)
         VALUES ($1, to_timestamp($2/1000.0), NOW(), $3, $4, $5, $6, $7)`,
        [res._stationUuid, res._connectedAt || Date.now(), durationSec, res._cc || null, res._region || null, res._city || null, res._lid || null]
      ).catch((e) => console.error("[listener_sessions]", e.message));
    }
    console.log(`[public-stream] disconnected — slug=${slug} streams=${clients.size}`);
  });
});

// Public "recently played" — last N aired songs, for embeddable website widgets.
// Same slug resolution + open CORS as the now-playing endpoints. Returns titled rows
// newest-first; the embed widget renders them with album art.
app.get("/public/station/:slug/recent-plays", async (req, res) => {
  const slug = String(req.params.slug || "").toLowerCase();
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 12));
  try {
    const { rows: sm } = await pool.query(
      `SELECT station_uuid FROM station_metadata WHERE slug = $1 AND public_enabled = true LIMIT 1`,
      [slug]
    );
    if (sm.length === 0) return res.status(404).json({ error: "not_found" });
    const { rows } = await pool.query(
      `SELECT title, artist, played_at
         FROM station_play_history
        WHERE station_uuid = $1 AND COALESCE(title, '') <> ''
        ORDER BY played_at DESC
        LIMIT $2`,
      [sm[0].station_uuid, limit]
    );
    res.json({ plays: rows.map((r) => ({ title: r.title, artist: r.artist || null, played_at: r.played_at })) });
  } catch (e) {
    console.error("[public/recent-plays]", e.message);
    res.status(500).json({ error: "server_error" });
  }
});

// ── Station metadata — public listener page config (Phase 2) ───────────────
// Authorize by license + ownership: resolve the license key, then confirm the
// :uuid station belongs to it. No plan gate here — a valid owner can configure;
// product tier-gating is handled in the desktop UI. Returns the station UUID or
// null (and sends the error response). All metadata routes gate on this.
// Resolve + authorize the station in :uuid. Accepts EITHER a dashboard Bearer JWT
// (Control Center) or x-license-key (desktop). Returns { licenseId, stationUuid, role }
// where role is the JWT role ('admin'|'user') or null for x-license-key (desktop is
// trusted/local). Write endpoints gate on role; reads don't.
async function getOwnedStation(req, res) {
  let licenseId = null, role = null;
  const authz = req.headers["authorization"] || "";
  if (authz.startsWith("Bearer ")) {
    try { const p = jwt.verify(authz.slice(7), JWT_SECRET); licenseId = p.lk; role = p.role; }
    catch { /* not a valid JWT — fall through to x-license-key */ }
  }
  if (licenseId == null) {
    const rawKey = req.headers["x-license-key"];
    if (!rawKey) { res.status(401).json({ error: "missing_auth" }); return null; }
    const license = await lookupLicense(rawKey).catch(() => null);
    if (!license) { res.status(401).json({ error: "invalid_license_key" }); return null; }
    licenseId = license.id;
  }
  const { rows } = await pool.query(
    `SELECT uuid FROM stations WHERE uuid = $1 AND license_key_id = $2`,
    [req.params.uuid, licenseId]
  );
  if (rows.length === 0) { res.status(404).json({ error: "station_not_found_or_not_owned" }); return null; }
  return { licenseId, stationUuid: req.params.uuid, role };
}

app.get("/api/station/:uuid/metadata", async (req, res) => {
  const owned = await getOwnedStation(req, res);
  if (!owned) return;
  try {
    const { rows } = await pool.query(`SELECT * FROM station_metadata WHERE station_uuid = $1`, [owned.stationUuid]);
    if (rows.length === 0) {
      return res.json({
        station_uuid: owned.stationUuid, slug: null, display_name: null, logo_url: null,
        color_primary: null, color_secondary: null, description: null, socials: {},
        stream_url: null, category: null, public_enabled: false,
      });
    }
    res.json(rows[0]);
  } catch (e) {
    console.error("[GET metadata]", e.message);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/station/:uuid/metadata", async (req, res) => {
  const owned = await getOwnedStation(req, res);
  if (!owned) return;
  if (owned.role !== null && owned.role !== "admin") return res.status(403).json({ error: "admin_required" });
  const uuid = owned.stationUuid;
  const b = req.body || {};
  try {
    // Slug is optional (a station can save branding before publishing a slug),
    // but public_enabled requires one.
    let slug = (b.slug == null || b.slug === "") ? null : String(b.slug).trim().toLowerCase();
    if (slug !== null) {
      const v = validateSlug(slug);
      if (!v.ok) return res.status(400).json({ error: `slug_${v.reason}` });
      const { rows: taken } = await pool.query(
        `SELECT 1 FROM station_metadata     WHERE slug = $1     AND station_uuid <> $2
         UNION
         SELECT 1 FROM station_slug_history WHERE old_slug = $1 AND station_uuid <> $2
         LIMIT 1`,
        [slug, uuid]
      );
      if (taken.length) return res.status(409).json({ error: "slug_taken" });
    }
    if (b.public_enabled && !slug) return res.status(400).json({ error: "slug_required_for_public" });

    // Archive the old slug for redirect history when it changes.
    const { rows: existing } = await pool.query(`SELECT slug FROM station_metadata WHERE station_uuid = $1`, [uuid]);
    const oldSlug = existing[0]?.slug || null;
    if (oldSlug && oldSlug !== slug) {
      await pool.query(
        `INSERT INTO station_slug_history (old_slug, station_uuid) VALUES ($1, $2)
         ON CONFLICT (old_slug) DO UPDATE SET station_uuid = $2, changed_at = NOW()`,
        [oldSlug, uuid]
      );
    }

    const socials = (b.socials && typeof b.socials === "object" && !Array.isArray(b.socials)) ? b.socials : {};
    // Ethercast category: only the known tabs, else null (no category).
    const CATEGORIES = ["music", "talk", "sports"];
    const category = CATEGORIES.includes(String(b.category)) ? String(b.category) : null;
    const { rows } = await pool.query(
      `INSERT INTO station_metadata
         (station_uuid, slug, display_name, logo_url, color_primary, color_secondary, description, socials, public_enabled, stream_url, category, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
       ON CONFLICT (station_uuid) DO UPDATE SET
         slug=$2, display_name=$3, logo_url=$4, color_primary=$5, color_secondary=$6,
         description=$7, socials=$8, public_enabled=$9, stream_url=$10, category=$11, updated_at=NOW()
       RETURNING *`,
      [uuid, slug, b.display_name ?? null, b.logo_url ?? null, b.color_primary ?? null,
       b.color_secondary ?? null, b.description ?? null, JSON.stringify(socials), !!b.public_enabled,
       b.stream_url ?? null, category]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error("[POST metadata]", e.message);
    res.status(500).json({ error: "server_error" });
  }
});

// Slug availability. license-key auth (any valid license). Optional &uuid=
// excludes the station being edited so re-saving your own slug reads available.
app.get("/api/slugs/check", async (req, res) => {
  // Accept a dashboard Bearer JWT or x-license-key — the check is global, so any
  // authenticated caller is fine.
  let authed = false;
  const authz = req.headers["authorization"] || "";
  if (authz.startsWith("Bearer ")) { try { jwt.verify(authz.slice(7), JWT_SECRET); authed = true; } catch { /* fall through */ } }
  if (!authed) {
    const rawKey = req.headers["x-license-key"];
    const license = rawKey ? await lookupLicense(rawKey).catch(() => null) : null;
    if (!license) return res.status(401).json({ error: "invalid_license_key" });
  }
  const slug = String(req.query.slug || "").trim().toLowerCase();
  const selfUuid = req.query.uuid ? String(req.query.uuid) : null;
  const v = validateSlug(slug);
  if (!v.ok) return res.json({ available: false, reason: v.reason });
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM station_metadata     WHERE slug = $1     AND ($2::text IS NULL OR station_uuid <> $2)
       UNION
       SELECT 1 FROM station_slug_history WHERE old_slug = $1 AND ($2::text IS NULL OR station_uuid <> $2)
       LIMIT 1`,
      [slug, selfUuid]
    );
    res.json({ available: rows.length === 0, reason: rows.length === 0 ? null : "taken" });
  } catch (e) {
    console.error("[slugs/check]", e.message);
    res.status(500).json({ error: "server_error" });
  }
});

// Sign a PUT to the PUBLIC logos bucket. Returns the stable public_url to store
// as logo_url. 503 if the public bucket env isn't configured (graceful degrade).
app.post("/api/station/:uuid/logo-upload-url", async (req, res) => {
  const owned = await getOwnedStation(req, res);
  if (!owned) return;
  if (owned.role !== null && owned.role !== "admin") return res.status(403).json({ error: "admin_required" });
  if (!logoStorageReady()) return res.status(503).json({ error: "logo_storage_unconfigured" });
  const ext = String(req.body?.ext || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!["png", "jpg", "jpeg", "webp"].includes(ext)) return res.status(400).json({ error: "bad_image_type" });
  const key = `station-logos/${owned.stationUuid}.${ext}`;
  try {
    const signed_url = await signLogoPutUrl(key);
    res.json({ signed_url, public_url: `${R2_PUBLIC_BASE_URL}/${key}`, expires_at: Date.now() + 900_000 });
  } catch (e) {
    console.error("[logo-upload-url] signing failed:", e.message);
    res.status(500).json({ error: "signing_failed", detail: e.message });
  }
});

// Sign a PUT for the on-air track's embedded cover art → PUBLIC bucket. Same auth as
// logo upload (license key is fine; no admin required — the on-air engine pushes this).
// Keyed by a content hash from the desktop so identical covers de-dupe and the URL is
// stable/cacheable. Returns the public_url to attach to the now-playing payload.
app.post("/api/station/:uuid/now-playing-art-upload-url", async (req, res) => {
  const owned = await getOwnedStation(req, res);
  if (!owned) return;
  if (!logoStorageReady()) return res.status(503).json({ error: "logo_storage_unconfigured" });
  const ext = String(req.body?.ext || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return res.status(400).json({ error: "bad_image_type" });
  const hash = String(req.body?.hash || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 64);
  if (!hash) return res.status(400).json({ error: "bad_hash" });
  const key = `now-playing-art/${owned.stationUuid}/${hash}.${ext}`;
  try {
    const signed_url = await signLogoPutUrl(key);
    res.json({ signed_url, public_url: `${R2_PUBLIC_BASE_URL}/${key}`, expires_at: Date.now() + 900_000 });
  } catch (e) {
    console.error("[np-art-upload-url] signing failed:", e.message);
    res.status(500).json({ error: "signing_failed", detail: e.message });
  }
});

// ── Companion command bus ─────────────────────────────────────

// Auth: dashboard Bearer JWT (admin — Control Center remote edits) OR x-license-key
// (companion/desktop transport controls). Fan-out + offline queue are per-license.
app.post("/api/cmd", async (req, res) => {
  let licenseId = null, viaJwt = false, jwtRole = null;
  const authz = req.headers["authorization"] || "";
  if (authz.startsWith("Bearer ")) {
    try { const p = jwt.verify(authz.slice(7), JWT_SECRET); licenseId = String(p.lk); jwtRole = p.role; viaJwt = true; }
    catch { /* not a valid JWT — fall through to x-license-key */ }
  }
  if (licenseId == null) {
    const rawKey = req.headers["x-license-key"];
    const license = rawKey ? await lookupLicense(rawKey).catch(() => null) : null;
    if (!license) return res.status(401).json({ error: "invalid_license_key" });
    if (!["pro", "station"].includes(license.plan)) return res.status(403).json({ error: "plan_required" });
    licenseId = String(license.id);
  }
  // Dashboard callers must be admin to issue commands (desktop x-license-key is trusted).
  if (viaJwt && jwtRole !== "admin") return res.status(403).json({ error: "admin_required" });

  const { cmd } = req.body;
  if (!cmd) return res.status(400).json({ error: "Missing cmd" });

  const payload = JSON.stringify({ cmd, data: req.body, ts: Math.floor(Date.now() / 1000) });
  const clients = sseClients.get(licenseId);
  if (clients && clients.size > 0) {
    for (const client of clients) {
      if (!client.writableEnded) client.write(`event: cmd\ndata: ${payload}\n\n`);
    }
    console.log(`[cmd] ${cmd} → SSE fan-out to ${clients.size} client(s) for license=${licenseId}`);
  } else {
    const q = pendingCmds.get(licenseId) || [];
    q.push({ cmd, data: req.body, ts: Math.floor(Date.now() / 1000) });
    if (q.length > 20) q.splice(0, q.length - 20);
    pendingCmds.set(licenseId, q);
  }
  res.json({ ok: true });
});

// SSE: Ether desktop subscribes here for instant command delivery.
// EventSource API cannot set custom headers, so license key comes from ?key= query param.
app.get("/api/cmd-stream", async (req, res) => {
  const rawKey = req.headers["x-license-key"] || req.query.key || "";
  if (!rawKey) return res.status(401).json({ error: "Missing x-license-key header or ?key= param" });
  const license = await lookupLicense(rawKey).catch(() => null);
  if (!license) return res.status(401).json({ error: "invalid_license_key" });
  if (!["pro","station"].includes(license.plan))
    return res.status(403).json({ error: "Studio or Network plan required" });

  res.set({
    "Content-Type":      "text/event-stream",
    "Cache-Control":     "no-cache",
    "X-Accel-Buffering": "no",   // disable Railway/Nginx proxy buffering
    "Connection":        "keep-alive",
  });
  res.flushHeaders();

  const licenseId = String(license.id);  // stable integer PK; license_key is NULL for bcrypt rows
  if (!sseClients.has(licenseId)) sseClients.set(licenseId, new Set());
  const clients = sseClients.get(licenseId);
  clients.add(res);
  console.log(`[cmd-stream] connected — license=${licenseId} streams=${clients.size}`);

  // Drain any commands queued for THIS license before the connection arrived
  const queued = pendingCmds.get(licenseId);
  if (queued && queued.length > 0) {
    pendingCmds.delete(licenseId);
    for (const c of queued) {
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
    if (clients.size === 0) sseClients.delete(licenseId);
    console.log(`[cmd-stream] disconnected — license=${licenseId} streams=${clients.size}`);
  });
});

app.get("/api/pending-cmds", requireLicense, (req, res) => {
  const id = String(req.license.id);
  const out = pendingCmds.get(id) || [];
  pendingCmds.delete(id);
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

  // Phase 3b: snapshot concurrent listener counts every 60s for peak/trend history.
  setInterval(async () => {
    try {
      const slugs = [...streamClients.keys()].filter((s) => (streamClients.get(s)?.size || 0) > 0);
      if (!slugs.length) return;
      const { rows } = await pool.query(`SELECT station_uuid, slug FROM station_metadata WHERE slug = ANY($1)`, [slugs]);
      for (const r of rows) {
        const count = streamClients.get(r.slug)?.size || 0;
        if (count > 0) await pool.query(`INSERT INTO station_listener_samples (station_uuid, count) VALUES ($1, $2)`, [r.station_uuid, count]);
      }
    } catch (e) { console.warn("[listener-sample]", e.message); }
  }, 60_000);

  // Phase 3: sample TRUE stream listeners from each public station's Icecast every 60s → ATH.
  // status-json.xsl is public (no creds); we match the source whose mount = the stream_url path.
  // Best-effort: a station whose Icecast is unreachable / has status-json off is simply skipped.
  setInterval(async () => {
    try {
      const { rows } = await pool.query(
        `SELECT station_uuid, stream_url FROM station_metadata WHERE public_enabled = true AND COALESCE(stream_url,'') <> ''`
      );
      await Promise.allSettled(rows.map(async (r) => {
        const n = await icecastListeners(r.stream_url);
        if (n !== null) await pool.query(`INSERT INTO station_stream_samples (station_uuid, listeners) VALUES ($1, $2)`, [r.station_uuid, n]);
      }));
    } catch (e) { console.warn("[stream-sample]", e.message); }
  }, 60_000);
}).catch(e => {
  console.error("[Ether] DB init failed:", e.message);
  process.exit(1);
});
