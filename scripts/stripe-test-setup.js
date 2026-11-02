'use strict';
// STRIPE TEST-MODE PRODUCTS FOR THE LOCAL BILLING TEST (2026-11-01).
//
//   node scripts/stripe-test-setup.js
//
// Reads ONLY C:\ether-backend\.env.stripe-test (gitignored). Refuses unless STRIPE_SECRET_KEY starts with sk_test_ and
// Stripe itself says the key is not live. Creates the six products and ten prices (names and descriptions: Jeff,
// docs/stripe-new-prices-steps-2026-11-01.md in the desktop repo; amounts: config/plans.json) and writes each price id
// to .env.stripe-test under the variable plans.json's stripe_price_env names. Idempotent: a product already made by this
// script (metadata ether_test_key) is reused, and a price already on it with the same amount and interval is reused.
// Never deletes anything.
const fs = require("node:fs");
const path = require("node:path");
const { parseEnvFile } = require("./billing-test-server");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env.stripe-test");
const catalog = require("../src/lib/plans").load();

// Jeff's names and descriptions (2026-11-01), keyed by the catalog's stripe_price_env keys.
const PRODUCTS = [
  { key: "local", name: "Ether Local", description: "Everything runs on your computers. No cloud features." },
  { key: "station", name: "Ether Live 128", description: "One station hosted on Ether’s cloud. 128 kbps, 50 listeners." },
  { key: "pro", name: "Ether Live 320", description: "One station hosted at full quality. 320 kbps, 150 listeners, priority support." },
  { key: "unlimited", name: "Ether Network", description: "5 hosted stations at 128 kbps, 250 listeners shared, priority support." },
  { key: "network_extra_station", name: "Network Extra Station", description: "One more station on your Network, adds 50 listeners." },
  { key: "listeners_50", name: "Listener Add-on", description: "50 more listeners for one station." },
];

function amounts(key) {
  const p = catalog.plans[key];
  if (p) return { monthly: p.price_monthly, annual: p.price_annual };
  if (key === "network_extra_station") return { monthly: catalog.plans.unlimited.extra_station.price_monthly };
  if (key === "listeners_50") return { monthly: catalog.addons.listeners_50.price_monthly };
  throw new Error(`no amount for ${key}`);
}

function writeEnv(updates) {
  const lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  const seen = new Set();
  const out = lines.map((l) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l);
    if (m && updates[m[1]] !== undefined) { seen.add(m[1]); return `${m[1]}=${updates[m[1]]}`; }
    return l;
  });
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) out.push(`${k}=${v}`);
  fs.writeFileSync(ENV_FILE, out.join("\n") + "\n");
}

async function main() {
  const env = parseEnvFile(fs.readFileSync(ENV_FILE, "utf8"));
  const key = String(env.STRIPE_SECRET_KEY || "").trim();
  if (!key.startsWith("sk_test_")) throw new Error("STOPPED: STRIPE_SECRET_KEY in .env.stripe-test does not start with sk_test_. No Stripe call was made.");
  const stripe = require("stripe")(key);
  const bal = await stripe.balance.retrieve();
  if (bal.livemode !== false) throw new Error("STOPPED: Stripe reports this key as LIVE. Nothing was created.");
  console.log("Stripe: test mode confirmed (balance.livemode = false)");

  const existing = [];
  for await (const p of stripe.products.list({ limit: 100, active: true })) existing.push(p);

  const updates = {};
  for (const def of PRODUCTS) {
    let prod = existing.find((p) => p.metadata && p.metadata.ether_test_key === def.key);
    if (prod) console.log(`product reused  ${prod.id}  ${def.name}`);
    else {
      prod = await stripe.products.create({ name: def.name, description: def.description, metadata: { ether_test_key: def.key, ether_billing_test: "2026-11-01" } });
      console.log(`product created ${prod.id}  ${def.name}`);
    }
    const prices = [];
    for await (const pr of stripe.prices.list({ product: prod.id, active: true, limit: 100 })) prices.push(pr);
    const a = amounts(def.key);
    for (const [period, dollars] of Object.entries(a)) {
      if (dollars == null) continue;
      const interval = period === "monthly" ? "month" : "year";
      const cents = Math.round(dollars * 100);
      let price = prices.find((pr) => pr.unit_amount === cents && pr.currency === "usd" && pr.recurring && pr.recurring.interval === interval);
      if (price) console.log(`  price reused  ${price.id}  $${dollars}/${interval}`);
      else {
        price = await stripe.prices.create({ product: prod.id, currency: "usd", unit_amount: cents, recurring: { interval }, metadata: { ether_test_key: `${def.key}_${period}` } });
        console.log(`  price created ${price.id}  $${dollars}/${interval}`);
      }
      const varName = catalog.stripe_price_env[`${def.key}_${period}`];
      if (!varName) throw new Error(`plans.json stripe_price_env has no ${def.key}_${period}`);
      updates[varName] = price.id;
    }
  }
  writeEnv(updates);
  console.log(`\nWrote ${Object.keys(updates).length} price ids to ${ENV_FILE}:`);
  for (const [k, v] of Object.entries(updates)) console.log(`  ${k}=${v}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
