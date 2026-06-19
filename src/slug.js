'use strict';
// Station public-page slug rules — the single source of truth, shared by the
// metadata + slug-check endpoints and unit-tested in slug.test.js. Keeping this
// pure (no DB, no express) means the endpoints can't drift from the validation.

// 2–32 chars, lowercase letters/digits/hyphens, no leading/trailing hyphen.
// (Allows 2-letter station codes like "ov"/"kj"; double-hyphens rejected below.)
const STATION_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

// Reserved — route names, infra words, and anything that would collide with a
// path on listen.ether-technologies.com or be confusing/abusable.
const RESERVED_SLUGS = new Set([
  "admin", "api", "www", "public", "account", "accounts", "auth", "login", "logout",
  "signup", "register", "dashboard", "console", "emergency", "mobile", "companion",
  "health", "sync", "audio", "backup", "backups", "guest", "guests", "join", "invite",
  "station", "stations", "listen", "app", "apps", "assets", "static", "cdn", "img",
  "images", "logo", "logos", "about", "help", "support", "contact", "terms", "privacy",
  "settings", "billing", "stripe", "webhook", "root", "system", "status", "me", "user", "users",
]);

// Returns { ok: true } or { ok: false, reason: 'invalid' | 'reserved' }.
function validateSlug(slug) {
  if (typeof slug !== "string" || !STATION_SLUG_RE.test(slug) || slug.includes("--")) {
    return { ok: false, reason: "invalid" };
  }
  if (RESERVED_SLUGS.has(slug)) return { ok: false, reason: "reserved" };
  return { ok: true };
}

// Best-effort slug suggestion from a free-text name. NOT authoritative — the
// result is still run through validateSlug before use (it may be too short,
// empty, or reserved). NFKD + dropping non-ASCII turns "Café" → "cafe".
function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")   // drop accents/diacritics + any non-ASCII
    .replace(/[^a-z0-9]+/g, "-")    // non-alnum runs → hyphen
    .replace(/-+/g, "-")            // collapse hyphens
    .replace(/^-+|-+$/g, "")        // trim hyphens
    .slice(0, 32)
    .replace(/-+$/g, "");           // re-trim after slice
}

module.exports = { STATION_SLUG_RE, RESERVED_SLUGS, validateSlug, slugify };
