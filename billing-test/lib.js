'use strict';
// Shared helpers for the local billing test drivers (2026-11-01). Talks only to the LOCAL server (127.0.0.1:8787), its
// control port (127.0.0.1:8788), the local account site (localhost:5174) and Stripe TEST mode.
const fs = require("node:fs");
const path = require("node:path");
const PW = process.env.PW_DIR || "C:\\Users\\jensj\\AppData\\Local\\Temp\\claude\\C--openair\\d859f1fc-74c8-4861-901b-87db15ad2780\\scratchpad\\pw\\node_modules\\playwright-core";
const { chromium } = require(PW);
const { parseEnvFile } = require("../scripts/billing-test-server");

// A second run beside the first (2026-11-01 rerun): BT_PORT / BT_CONTROL_PORT / BT_SITE.
const API = `http://127.0.0.1:${process.env.BT_PORT || 8787}`;
const CTL = `http://127.0.0.1:${process.env.BT_CONTROL_PORT || 8788}`;
const SITE = process.env.BT_SITE || "http://localhost:5174";
const PASSWORD = "ether-test-1";
const SCREENS = path.join(__dirname, process.env.BT_SCREENS || "screens");
const RESULTS = path.join(__dirname, process.env.BT_RESULTS || "results.json");
fs.mkdirSync(SCREENS, { recursive: true });

function stripe() {
  const env = parseEnvFile(fs.readFileSync(path.join(__dirname, "..", ".env.stripe-test"), "utf8"));
  const key = String(env.STRIPE_SECRET_KEY || "").trim();
  if (!key.startsWith("sk_test_")) throw new Error("STOPPED: STRIPE_SECRET_KEY does not start with sk_test_");
  return { s: require("stripe")(key), env };
}

async function db(sql) {
  const r = await fetch(`${CTL}/db?sql=${encodeURIComponent(sql)}`);
  const j = await r.json();
  if (!r.ok) throw new Error(`db: ${j.error}`);
  return j;
}
async function api(method, p, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(API + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
// One sign-in per account per run (the server allows 40 sign-ins per 15 minutes per address): tokens are kept in
// billing-test/tokens.json (gitignored) and reused while the server answers them.
const TOKENS = path.join(__dirname, process.env.BT_TOKENS || "tokens.json");
const tokens = () => { try { return JSON.parse(fs.readFileSync(TOKENS, "utf8")); } catch { return {}; } };
async function signup(email, name) {
  const t = tokens()[email];
  if (t && (await api("GET", "/api/user/me", null, t)).status === 200) return t;
  const tok = await freshSignup(email, name);
  fs.writeFileSync(TOKENS, JSON.stringify({ ...tokens(), [email]: tok }, null, 1));
  return tok;
}
async function freshSignup(email, name) {
  const r = await api("POST", "/api/user/signup", { name, email, password: PASSWORD });
  if (r.status !== 200 && r.status !== 201 && r.status !== 409) throw new Error(`signup ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  await fetch(`${CTL}/verify`, { method: "POST", body: JSON.stringify({ email }) });
  const l = await api("POST", "/api/user/login", { email, password: PASSWORD });
  if (l.status !== 200) throw new Error(`login ${email}: ${l.status}`);
  return l.body.token;
}

let n = 0;
function nextShot() {
  const have = fs.readdirSync(SCREENS).map((f) => parseInt(f, 10)).filter(Number.isFinite);
  n = Math.max(n, have.length ? Math.max(...have) : 0) + 1;
  return String(n).padStart(3, "0");
}
const captions = () => { try { return JSON.parse(fs.readFileSync(path.join(SCREENS, "captions.json"), "utf8")); } catch { return {}; } };
function caption(file, text) { const c = captions(); c[file] = text; fs.writeFileSync(path.join(SCREENS, "captions.json"), JSON.stringify(c, null, 1)); }
async function shot(page, slug, text, opts = {}) {
  const file = `${nextShot()}-${slug}.png`;
  await page.screenshot({ path: path.join(SCREENS, file), fullPage: opts.fullPage !== false });
  caption(file, text);
  console.log(`  screenshot ${file}`);
  return file;
}
function record(id, result) {
  let all = {}; try { all = JSON.parse(fs.readFileSync(RESULTS, "utf8")); } catch {}
  all[id] = { ...result, at: new Date().toISOString() };
  fs.writeFileSync(RESULTS, JSON.stringify(all, null, 1));
}

async function browser() {
  return chromium.launch({ channel: "chrome", headless: true });
}

/** Sign in on the local account site (the real login page). */
async function siteLogin(page, email) {
  // reuse the account's token (the site keeps it in localStorage as ether_user_token) — no extra sign-in
  const t = await signup(email);
  await page.goto(`${SITE}/login`);
  await page.evaluate((tok) => localStorage.setItem("ether_user_token", tok), t);
  await page.goto(`${SITE}/`);
  if (await page.waitForSelector(".hero", { timeout: 8000 }).catch(() => null)) return;
  await page.goto(`${SITE}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector(".hero", { timeout: 20000 });
}

/** Fill Stripe Checkout (hosted, test mode) with a test card and pay. */
async function payCheckout(page, card, beforePay, { expiry = "12 / 34" } = {}) {
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  const cardBtn = page.locator('[data-testid="card-accordion-item-button"]');
  if (await cardBtn.count()) {
    // the accordion button is an invisible overlay on the "Card" row; click where the row is drawn
    const box = await page.getByText("Card", { exact: true }).first().boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    else await cardBtn.first().click({ force: true });
  }
  await page.waitForSelector("#cardNumber", { timeout: 30000 });
  await page.fill("#cardNumber", card);
  await page.fill("#cardExpiry", expiry);
  await page.fill("#cardCvc", "123");
  if (await page.locator("#billingName").count()) await page.fill("#billingName", "Ether Test");
  if (await page.locator("#billingPostalCode").count()) await page.fill("#billingPostalCode", "89101");
  const link = page.locator("#enableStripePass");
  if (await link.count() && await link.isChecked().catch(() => false)) await link.uncheck().catch(() => {});
  if (beforePay) await beforePay();
  await page.click('[data-testid="hosted-payment-submit-button"], button.SubmitButton');
}

/** The running EtherCast dev window (billing-test/desktop.js, CDP 127.0.0.1:9333): { br, page }. br.close() only detaches. */
async function appPage() {
  const br = await chromium.connectOverCDP("http://127.0.0.1:9333");
  for (const ctx of br.contexts()) for (const p of ctx.pages()) {
    const u = p.url();
    if (/^http:\/\/127\.0\.0\.1:1420\//.test(u) && !/#(popout|desk|nowplaying|guesteditor)/.test(u)) return { br, page: p };
  }
  throw new Error("EtherCast main window not found on CDP 9333");
}

/** Pull the audio level samples the page has collected (installLevelLog) and append them to billing-test/audio-levels.jsonl. */
const LEVELS = path.join(__dirname, process.env.BT_LEVELS || "audio-levels.jsonl");
async function installLevelLog(page) {
  // Once a second, in the app page: the engine's own counters (frames_total = samples rendered, rt_callbacks = output
  // callbacks — they only climb while audio is being output), deck A's and the master's level, deck A's status, and how
  // many audio:levels pushes arrived in that second. Installed once per page load (window.__lvl2).
  await page.evaluate(() => {
    if (window.__lvl2) return;
    window.__lvl2 = true; window.__lvl = []; let pushes = 0;
    window.ether.audio.onLevels(() => { pushes++; });
    setInterval(async () => {
      try {
        const [l, st] = await Promise.all([window.ether.audio.getLevels(1), window.ether.audio.getState(1)]);
        window.__lvl.push({ t: Date.now(), a: l.a, master: l.master, frames_total: l.frames_total, rt_callbacks: l.rt_callbacks,
                            device_errors: l.rt_device_errors, deckA: st && st.deckA && st.deckA.status, pushes });
      } catch (e) { window.__lvl.push({ t: Date.now(), error: String((e && e.message) || e), pushes }); }
      pushes = 0;
      if (window.__lvl.length > 20000) window.__lvl.shift();
    }, 1000);
  });
}
async function drainLevels(page, stage) {
  const rows = (await page.evaluate(() => { const r = window.__lvl || []; window.__lvl = []; return r; })).filter((r) => !("sample" in r));   // the first version's rows (this page load) are dropped
  fs.appendFileSync(LEVELS, rows.map(({ t, ...r }) => JSON.stringify({ stage, at: new Date(t).toISOString(), ...r })).join("\n") + (rows.length ? "\n" : ""));
  return rows;
}

async function waitFor(fn, ms = 60000, every = 1000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await new Promise((r) => setTimeout(r, every)); }
  return last;
}

module.exports = { API, CTL, SITE, PASSWORD, SCREENS, stripe, db, api, signup, shot, caption, record, browser, siteLogin, payCheckout, waitFor, appPage, installLevelLog, drainLevels, LEVELS };
