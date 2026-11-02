'use strict';
// THE LOCAL BILLING TEST SERVER — every billing notice on screen, away from production and every real customer.
//
//   node scripts/billing-test-server.js
//
// The REAL server (src/index.js: real routes, real boot schema) on an in-memory Postgres (pg-mem, through
// test/server-harness.js), at http://127.0.0.1:8787. Ephemeral: everything is gone when it stops. Email is RECORDED,
// never sent. It never reads C:\ether-backend\.env, never connects to DATABASE_URL, and never sees a production secret.
//
// STRIPE: optional. Without keys every state is seeded straight into the database and every notice shows. With Stripe
// TEST keys in C:\ether-backend\.env.billing-test (gitignored):
//     STRIPE_SECRET_KEY=sk_test_...         (Stripe dashboard, Test mode → Developers → API keys → Secret key)
//     STRIPE_WEBHOOK_SECRET=whsec_...       (optional: printed by `stripe listen --forward-to http://127.0.0.1:8787/webhook/stripe`)
// the "card declined", "card expired", "in grace" and "paid OK" accounts also get Stripe TEST customers with Stripe's
// test cards, so "Update card" opens a real (test-mode) Customer Portal. It REFUSES to start if any key is live
// (sk_live_, rk_live_, pk_live_).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = process.env.BILLING_TEST_ENV_FILE || path.join(ROOT, ".env.billing-test");
const PORT = Number(process.env.BILLING_TEST_PORT || 8787);
const PASSWORD = "ether-test-1";
const ACCOUNT_URL = process.env.BILLING_TEST_ACCOUNT_URL || "http://localhost:5174";
// BILLING_TEST_SEED=0: start with an EMPTY database (no seeded state accounts) — the purchase run makes its own accounts.
const SEED = process.env.BILLING_TEST_SEED !== "0";
// BILLING_TEST_CONTROL_PORT: a second port on 127.0.0.1 only, for the test driver: GET /db?sql=SELECT… (read-only
// SELECT on the in-memory database), POST /verify {email} (marks the sign-up confirmed — the email is recorded, never
// sent), GET /emails (what would have been sent). Off unless set.
const CONTROL_PORT = Number(process.env.BILLING_TEST_CONTROL_PORT || 0);

/** KEY=VALUE lines (# comments, optional quotes). Never dotenv: it must not pick up any other file. */
function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** Throws when any value is a live Stripe key. A webhook secret cannot be told live from test, so only keys are checked. */
function refuseLiveKeys(env) {
  const live = Object.entries(env).filter(([, v]) => /^(sk|rk|pk)_live_/.test(String(v || "").trim())).map(([k]) => k);
  if (live.length) throw new Error(`REFUSED: ${live.join(", ")} ${live.length === 1 ? "is a" : "are"} LIVE Stripe key${live.length === 1 ? "" : "s"}. This test server runs only with Stripe TEST keys (sk_test_…). Nothing was started.`);
  const sk = env.STRIPE_SECRET_KEY;
  if (sk && !/^(sk|rk)_test_/.test(sk)) throw new Error("REFUSED: STRIPE_SECRET_KEY is not a test key (sk_test_… or rk_test_…). Nothing was started.");
}

const DAY = 86400000;
const at = (d) => new Date(Date.now() + d * DAY);
// One account per state. Dates are relative to now so each notice shows on any day.
function accounts() {
  const now = new Date();
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [
    { slug: "trial-ending", name: "TEST trial ending (2 days)", lic: { expires_at: at(2) }, expect: "trial_ending" },
    { slug: "trial-ended", name: "TEST trial ended", lic: { expires_at: at(-1) }, expect: "trial_ended" },
    { slug: "card-declined", name: "TEST card declined", stripe: "pm_card_chargeCustomerFail",
      lic: { payment_failed_at: at(-1), card_brand: "visa", card_last4: "0341", card_exp_month: 12, card_exp_year: now.getUTCFullYear() + 3 }, expect: "payment_failed" },
    { slug: "card-expired", name: "TEST card expired", stripe: "pm_card_visa",
      lic: { card_brand: "visa", card_last4: "4242", card_exp_month: lastMonth.getUTCMonth() + 1, card_exp_year: lastMonth.getUTCFullYear() }, expect: "card_expired" },
    { slug: "in-grace", name: "TEST in grace", stripe: "pm_card_visa", lic: { expires_at: at(-2) }, expect: "grace" },
    { slug: "lapsed", name: "TEST lapsed", lic: { expires_at: at(-10) }, expect: "lapsed" },
    { slug: "paid-ok", name: "TEST paid OK", stripe: "pm_card_visa",
      lic: { card_brand: "visa", card_last4: "4242", card_exp_month: 12, card_exp_year: now.getUTCFullYear() + 3 }, expect: null },
  ];
}

async function stripeCustomer(stripe, a, email) {
  const cus = await stripe.customers.create({ email, name: a.name, description: "Ether billing test server (TEST)", metadata: { ether_test: a.slug } });
  const pm = await stripe.paymentMethods.attach(a.stripe, { customer: cus.id });
  await stripe.customers.update(cus.id, { invoice_settings: { default_payment_method: pm.id } });
  return cus.id;
}

async function main() {
  // 1. Keys: the test file only, refused if live — BEFORE anything else loads.
  const fileEnv = fs.existsSync(ENV_FILE) ? parseEnvFile(fs.readFileSync(ENV_FILE, "utf8")) : {};
  refuseLiveKeys(fileEnv);
  refuseLiveKeys({ STRIPE_SECRET_KEY_FROM_SHELL: process.env.STRIPE_SECRET_KEY || "" });   // a live key in the shell: refuse too

  // 2. Environment for the server: nothing from production. dotenv in index.js reads .env from the current directory,
  //    so run from an empty folder of our own; every value the server could reach out with is set here explicitly.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ether-billing-test-"));
  process.chdir(cwd);
  delete process.env.DATABASE_URL;
  Object.assign(process.env, {
    STRIPE_SECRET_KEY: fileEnv.STRIPE_SECRET_KEY || "",
    STRIPE_WEBHOOK_SECRET: fileEnv.STRIPE_WEBHOOK_SECRET || "",
    RESEND_API_KEY: "re_test_never_sent",
    R2_ACCOUNT_ID: "testaccount", R2_ACCESS_KEY_ID: "test-access-key", R2_SECRET_ACCESS_KEY: "test-secret-key",
    R2_BUCKET: "test-bucket", R2_PUBLIC_BUCKET: "test-public-bucket", R2_PUBLIC_BASE_URL: "https://r2.test.invalid",
    ACCOUNT_APP_URL: ACCOUNT_URL,
    PORTAL_ALLOW_LOCALHOST: "1",
    BILLING_EMAILS: "",
    TIER_EXEMPT_LICENSE_IDS: "",
    PLAN_ENFORCE: "",
  });
  for (const k of Object.keys(fileEnv)) if (/^PRICE_/.test(k)) process.env[k] = fileEnv[k];

  const { startServer } = require(path.join(ROOT, "test", "server-harness.js"));
  const h = await startServer({ port: PORT });
  const srv = require(path.join(ROOT, "src", "index.js"));
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const stripe = stripeKey ? require("stripe")(stripeKey) : null;

  // 3. Seed: one TEST account per state.
  const crypto = require("node:crypto");
  const bcrypt = require("bcrypt");
  const hash = await bcrypt.hash(PASSWORD, 8);
  const rows = [];
  for (const a of SEED ? accounts() : []) {
    const email = `test+${a.slug}@ether-test.invalid`;
    const key = `ETH-STN-TEST-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const lic = { email, license_key: key, key_prefix: key.slice(0, 12), plan: "station", active: true, account_name: a.name, ...a.lic };
    let stripeNote = "";
    if (a.stripe) {
      lic.stripe_subscription_id = `sub_TEST_${a.slug.replace(/-/g, "_")}`;   // not a real subscription: the notices read the columns
      lic.stripe_customer_id = `cus_TEST_${a.slug.replace(/-/g, "_")}`;
      if (stripe) {
        try { lic.stripe_customer_id = await stripeCustomer(stripe, a, email); stripeNote = `Stripe test customer ${lic.stripe_customer_id} (${a.stripe})`; }
        catch (e) { stripeNote = `Stripe customer not made: ${e.message}`; }
      }
    }
    const cols = Object.keys(lic);
    const id = (await h.pool.query(`INSERT INTO licenses (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`, cols.map(c => lic[c]))).rows[0].id;
    await h.pool.query(`INSERT INTO users (name, email, password_hash, email_verified, license_key_id, trial_ends_at, unsubscribe_token) VALUES ($1,$2,$3,true,$4,$5,$6)`,
      [a.name, email, hash, id, a.lic.expires_at || null, crypto.randomBytes(8).toString("hex")]);
    await h.pool.query(`INSERT INTO stations (uuid, license_key_id, name) VALUES ($1,$2,$3)`, [crypto.randomUUID(), id, `${a.name} — Station`]);
    // what the desktop would be told, through the real route
    const r = await h.call("POST", "/account/connect", { body: { license_key: key, machine_id: `billing-test-${a.slug}` } });
    const shown = r.body && r.body.billing_notice ? r.body.billing_notice.kind : null;
    rows.push({ name: a.name, email, key, shown, expect: a.expect, stripeNote });
  }

  // 4. One pass of the billing emails — recorded, never sent.
  const mail = SEED ? await srv.runBillingEmails() : { sent: [] };
  if (CONTROL_PORT) startControl(h, CONTROL_PORT);

  const L = [];
  L.push("", "ETHER BILLING TEST SERVER — in-memory database, nothing reaches production, email recorded only", "");
  L.push(`  API:       http://127.0.0.1:${PORT}`);
  L.push(`  Stripe:    ${stripe ? "TEST keys from " + ENV_FILE : "none (states seeded directly; Update card answers 503 stripe_unconfigured)"}`);
  L.push(`  Webhook:   ${process.env.STRIPE_WEBHOOK_SECRET ? `stripe listen --forward-to http://127.0.0.1:${PORT}/webhook/stripe` : "no STRIPE_WEBHOOK_SECRET (webhook calls are refused)"}`);
  L.push(`  Password for every account: ${PASSWORD}`, "");
  for (const r of rows) {
    const ok = r.shown === r.expect ? "" : `   << expected ${r.expect}`;
    L.push(`  ${r.name.padEnd(28)} ${r.email.padEnd(42)} ${r.key}   notice: ${r.shown || "none"}${ok}`);
    if (r.stripeNote) L.push(`  ${"".padEnd(28)} ${r.stripeNote}`);
  }
  L.push("", `  Billing emails (recorded, not sent): ${mail.sent.length} — ${mail.sent.map(s => `${s.kind} → ${s.to}`).join(", ") || "none"}`, "");
  L.push("POINT AN APP AT IT", "");
  L.push(`  Dashboard (C:\\ether-dashboard — reads VITE_API_BASE, src/api.ts):`);
  L.push(`    cd C:\\ether-dashboard`);
  L.push(`    $env:VITE_API_BASE="http://127.0.0.1:${PORT}"; npx vite --port 5173`);
  L.push(`    open http://localhost:5173 → owner sign-in with an email above and ${PASSWORD} → the banner, and Account → Billing`, "");
  L.push(`  Account site (C:\\ether-signup — reads VITE_API_BASE, src/api.ts):`);
  L.push(`    cd C:\\ether-signup`);
  L.push(`    $env:VITE_API_BASE="http://127.0.0.1:${PORT}"; npx vite --port 5174`);
  L.push(`    open http://localhost:5174/login → sign in → the notice with its button (this server's ACCOUNT_APP_URL is ${ACCOUNT_URL})`, "");
  L.push(`  Desktop (C:\\openair): NO backend-URL setting exists — ETHER_BACKEND_URL is a constant in src/lib/etherBackend.ts and`);
  L.push(`    electron/lib/etherBackend.js (production). The desktop cannot be pointed here without a source change. To see what it`);
  L.push(`    would receive: POST http://127.0.0.1:${PORT}/account/connect {"license_key":"<key above>","machine_id":"x"} → billing_notice`, "");
  L.push("Ctrl+C stops it; everything is discarded.", "");
  console.log(L.join("\n"));
  return h;
}

/** The test driver's port (127.0.0.1 only): read-only SELECTs, confirm a sign-up, the recorded emails. */
function startControl(h, port) {
  const http = require("node:http");
  const send = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body, null, 1)); };
  http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && u.pathname === "/db") {
        const sql = String(u.searchParams.get("sql") || "").trim();
        if (!/^select\s/i.test(sql) || /;\s*\S/.test(sql)) return send(res, 400, { error: "SELECT only" });
        return send(res, 200, (await h.pool.query(sql)).rows);
      }
      if (req.method === "POST" && u.pathname === "/verify") {
        let raw = ""; for await (const c of req) raw += c;
        const email = String(JSON.parse(raw || "{}").email || "").toLowerCase();
        const r = await h.pool.query(`UPDATE users SET email_verified = true WHERE lower(email) = $1`, [email]);
        return send(res, 200, { verified: r.rowCount });
      }
      if (req.method === "GET" && u.pathname === "/emails") return send(res, 200, h.emails.map((m) => ({ to: m.to, subject: m.subject })));
      send(res, 404, { error: "not_found" });
    } catch (e) { send(res, 500, { error: e.message }); }
  }).listen(port, "127.0.0.1", () => console.log(`  Control:   http://127.0.0.1:${port} (/db?sql=SELECT…, POST /verify, /emails) — test driver only`));
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { parseEnvFile, refuseLiveKeys, accounts, PASSWORD };
