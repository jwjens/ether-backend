'use strict';
// THE PLAN CHECK ON EVERY CLOUD ROUTE (docs/paywall-entitlements-plan.md §4.3 requireFeature; Jeff, 2026-10-29: "The
// server is the source of truth for cloud features and enforces them on every cloud route. Local features never read
// an entitlement.").
//
// One middleware, mounted before every route. CLOUD_ROUTES below is the one list of which route uses which cloud
// feature. For a listed route it finds the account from whatever credential the request carries (license key, a
// dashboard or user token, a station in the path, a Park page address), asks entitlements.js whether the plan allows
// the feature, and:
//   · SHADOW (default): lets the request through and records "would refuse" — license, plan, status, feature — so
//     who would lose access is known BEFORE anything is refused (GET /api/platform/plan-refusals).
//   · ENFORCE (Railway PLAN_ENFORCE=1): answers 402 { error: "plan_required", feature, plan, status, upgrade_url }.
// A request whose account can't be found passes to the route, whose own sign-in check refuses it as today.
// The route's own sign-in check still runs: this only ever adds a refusal, never an admission.
const crypto = require("crypto");
const { entitlementsFor, allows } = require("./entitlements");

/** [methods ("*" = any), path pattern, feature]. Order matters only for overlapping prefixes (relay before link). */
const CLOUD_ROUTES = [
  ["*", /^\/sync(\/|$)/, "sync"],
  ["*", /^\/library(\/|$)/, "r2_library"],
  ["*", /^\/audio\//, "r2_library"],
  ["*", /^\/api\/account\/audio\/upload-url$/, "r2_library"],
  ["*", /^\/api\/account\/station\/[^/]+\/borrowed-library$/, "r2_library"],
  ["*", /^\/backup(\/|$)/, "cloud_backup"],
  ["*", /^\/api\/account\/data\/sync$/, "control_center"],
  ["*", /^\/api\/account\/station\/[^/]+\/(data|staged)(\/|$)/, "control_center"],
  ["*", /^\/api\/account\/stations(\/|$)/, "control_center"],
  ["*", /^\/api\/account\/(health|devices|users)(\/|$)/, "control_center"],
  ["*", /^\/account\/devices$/, "control_center"],
  ["*", /^\/api\/cmd(\/|$)/, "web_remote"],
  ["*", /^\/api\/cmd-stream$/, "web_remote"],
  ["*", /^\/api\/pending-cmds$/, "web_remote"],
  ["*", /^\/api\/account\/station\/[^/]+\/(analytics|affidavit|listeners|listenership)$/, "analytics_web"],
  ["*", /^\/api\/account\/play-history$/, "analytics_web"],
  ["POST", /^\/api\/station\/[^/]+\/(metadata|logo-upload-url|now-playing-art-upload-url)$/, "public_page"],
  ["POST", /^\/api\/user\/(account-slug|account-logo-upload-url)$/, "public_page"],
  ["POST", /^\/api\/now-playing$/, "now_playing"],
  ["*", /^\/api\/account\/jukebox\//, "jukebox"],
  ["*", /^\/api\/ops\/token$/, "park_ops"],
  ["POST|PUT", /^\/public\/ops\/[^/]+\/(?!login$|logout$|me$).+/, "park_ops"],
  ["*", /^\/api\/link\/relay(\/|$)/, "link_relay"],
  ["*", /^\/api\/link(\/|$)/, "link_pairing"],
  ["*", /^\/invite\/send$/, "show_guests"],
  ["*", /^\/api\/accounts\/[^/]+\/(members|positions|stations)(\/|$)/, "members"],
];

function featureFor(method, p) {
  for (const [m, re, f] of CLOUD_ROUTES) if ((m === "*" || m.split("|").includes(method)) && re.test(p)) return f;
  return null;
}

/**
 * @param {object} o
 * @param o.pool, o.catalog, o.jwt, o.jwtSecret
 * @param o.lookupKey  async rawKey → licenses row, INCLUDING a lapsed one (so a lapsed account is judged, not skipped)
 * @param o.enforce    () → boolean (read per request, so the Railway variable takes effect on restart)
 */
function createFeatureGate({ pool, catalog, jwt, jwtSecret, lookupKey, enforce = () => process.env.PLAN_ENFORCE === "1",
                             now = () => Date.now(), log = console }) {
  const keyCache = new Map();   // sha256(key) → { row, at }: a bcrypt compare per request would double every call's cost
  const refusals = new Map();   // "licenseId|feature" → { license_id, plan, status, feature, count, first, last, path }
  const CACHE_MS = 60 * 1000;

  async function byKey(raw) {
    const h = crypto.createHash("sha256").update(raw).digest("hex");
    const c = keyCache.get(h);
    if (c && now() - c.at < CACHE_MS) return c.row;
    const row = await lookupKey(raw).catch(() => null);
    keyCache.set(h, { row, at: now() });
    if (keyCache.size > 5000) keyCache.delete(keyCache.keys().next().value);
    return row;
  }
  const byId = async (id) => id ? (await pool.query(`SELECT * FROM licenses WHERE id = $1`, [Number(id)])).rows[0] || null : null;

  async function licenseOf(req) {
    const raw = req.headers["x-license-key"] || (req.body && typeof req.body.license_key === "string" && req.body.license_key.trim()) || req.query.key;
    if (raw) return byKey(String(raw));
    const a = req.headers["authorization"] || "";
    if (a.startsWith("Bearer ")) {
      let p = null; try { p = jwt.verify(a.slice(7), jwtSecret); } catch { return null; }
      if (p.lk) return byId(p.lk);
      if (p.typ === "user" && p.uid) {
        const u = (await pool.query(`SELECT license_key_id FROM users WHERE id = $1`, [p.uid])).rows[0];
        return byId(u && u.license_key_id);
      }
      return null;
    }
    let m = /^\/api\/station\/([^/]+)\//.exec(req.path);
    if (m) {
      const s = (await pool.query(`SELECT license_key_id FROM stations WHERE uuid = $1`, [m[1]])).rows[0];
      return byId(s && s.license_key_id);
    }
    m = /^\/public\/ops\/([^/]+)\//.exec(req.path);
    if (m) {
      const s = (await pool.query(
        `SELECT s.license_key_id FROM station_metadata sm JOIN stations s ON s.uuid = sm.station_uuid WHERE lower(sm.slug) = lower($1)`, [m[1]])).rows[0];
      return byId(s && s.license_key_id);
    }
    return null;
  }

  function record(lic, ent, feature, p) {
    const k = `${lic.id}|${feature}`;
    const r = refusals.get(k);
    const t = new Date(now()).toISOString();
    if (r) { r.count++; r.last = t; r.status = ent.status; return; }
    refusals.set(k, { license_id: Number(lic.id), email: lic.email || null, plan: ent.plan, status: ent.status, feature, count: 1, first: t, last: t, path: p });
    log.warn(`[plan] ${enforce() ? "refused" : "would refuse"} license:${lic.id} plan:${ent.plan} status:${ent.status} feature:${feature} ${p}`);
  }

  async function middleware(req, res, next) {
    const feature = featureFor(req.method, req.path);
    if (!feature) return next();
    let lic;
    try { lic = await licenseOf(req); } catch (e) { log.error("[plan] account lookup:", e.message); return next(); }
    if (!lic) return next();   // no account found: the route's own sign-in check decides, as today
    const ent = entitlementsFor(lic, { catalog, now: now() });
    if (allows(ent, feature)) return next();
    record(lic, ent, feature, req.path);
    if (!enforce()) return next();
    const required = (catalog.features[feature] || {}).plans || [];
    return res.status(402).json({
      error: "plan_required", feature, feature_label: (catalog.features[feature] || {}).label || feature,
      plan: ent.plan, status: ent.status, required_plans: required, upgrade_url: "https://signup.ether-technologies.com",
    });
  }

  /** What the gate has refused (or would refuse, in shadow) since the server started. */
  function report() {
    return { mode: enforce() ? "enforce" : "shadow", refusals: [...refusals.values()].sort((a, b) => a.license_id - b.license_id || a.feature.localeCompare(b.feature)) };
  }
  return { middleware, report, licenseOf };
}

module.exports = { CLOUD_ROUTES, featureFor, createFeatureGate };
