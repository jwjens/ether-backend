'use strict';
// THE LOCAL BILLING TEST RUN (2026-11-01): the real server on a brand-new in-memory database + `stripe listen`, both on
// the Stripe TEST key in C:\ether-backend\.env.stripe-test. Nothing here reads .env, DATABASE_URL or Railway.
//
//   node billing-test/run-local.js
//
// 1. Refuses unless STRIPE_SECRET_KEY starts with sk_test_.
// 2. Asks the Stripe CLI for the webhook signing secret (`stripe listen --print-secret`) and writes it to
//    .env.stripe-test as STRIPE_WEBHOOK_SECRET.
// 3. Starts scripts/billing-test-server.js (empty database, control port 8788) and
//    `stripe listen --forward-to http://127.0.0.1:8787/webhook/stripe`. The key is passed to the CLI as an argument and
//    never printed. Ctrl+C (or killing this process) stops both.
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env.stripe-test");
const STRIPE = process.env.STRIPE_CLI || path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "stripe.exe");
const { parseEnvFile } = require("../scripts/billing-test-server");
// A second run beside the first (2026-11-01 rerun): BT_PORT / BT_CONTROL_PORT / BT_SITE (defaults 8787 / 8788 / 5174).
const PORT = process.env.BT_PORT || "8787", CONTROL = process.env.BT_CONTROL_PORT || "8788", SITE = process.env.BT_SITE || "http://localhost:5174";

const env = parseEnvFile(fs.readFileSync(ENV_FILE, "utf8"));
const key = String(env.STRIPE_SECRET_KEY || "").trim();
if (!key.startsWith("sk_test_")) { console.error("STOPPED: STRIPE_SECRET_KEY does not start with sk_test_. Nothing was started."); process.exit(1); }

const secret = execFileSync(STRIPE, ["listen", "--api-key", key, "--print-secret"], { encoding: "utf8" }).trim();
if (!/^whsec_/.test(secret)) { console.error("STOPPED: the Stripe CLI did not print a webhook secret."); process.exit(1); }
const lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/).filter((l) => l && !/^STRIPE_WEBHOOK_SECRET=/.test(l));
lines.push(`STRIPE_WEBHOOK_SECRET=${secret}`);
fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n");
console.log(`[run-local] webhook signing secret written to ${ENV_FILE} (whsec_…${secret.slice(-4)})`);

const stamp = (name) => (d) => process.stdout.write(String(d).split(/\r?\n/).filter(Boolean).map((l) => `[${name}] ${l}`).join("\n") + "\n");
const server = spawn(process.execPath, [path.join(ROOT, "scripts", "billing-test-server.js")], {
  env: { ...process.env, BILLING_TEST_ENV_FILE: ENV_FILE, BILLING_TEST_SEED: "0", BILLING_TEST_PORT: PORT, BILLING_TEST_CONTROL_PORT: CONTROL, BILLING_TEST_ACCOUNT_URL: SITE },
});
server.stdout.on("data", stamp("server")); server.stderr.on("data", stamp("server!"));
const EVENTS = "checkout.session.completed,invoice.payment_succeeded,invoice.paid,invoice.payment_failed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,payment_method.attached,customer.updated";
const listen = spawn(STRIPE, ["listen", "--api-key", key, "--events", EVENTS, "--forward-to", `http://127.0.0.1:${PORT}/webhook/stripe`]);
listen.stdout.on("data", stamp("stripe")); listen.stderr.on("data", stamp("stripe"));
const stop = () => { try { server.kill(); } catch {} try { listen.kill(); } catch {} process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
server.on("exit", (c) => { console.log(`[run-local] server exited ${c}`); stop(); });
listen.on("exit", (c) => { console.log(`[run-local] stripe listen exited ${c}`); stop(); });
