'use strict';
// STEP 3a — buy each plan, monthly and yearly, with 4242 4242 4242 4242 on the local account site + Stripe test
// Checkout; then check the license in the local DB (plan, active, Stripe ids) and the limits the server hands out.
//   node billing-test/drive-a.js [startIndex] [count]
const L = require("./lib");

const CATALOG = require("../src/lib/plans").load();
const ENT = require("../src/lib/entitlements");
const CASES = [];
for (const plan of ["local", "station", "pro", "unlimited"]) for (const period of ["monthly", "annual"]) CASES.push({ plan, period });

async function one(br, i, c) {
  const email = `test${i + 1}@ether.test`;
  const label = CATALOG.plans[c.plan].label;
  const id = `a-${c.plan}-${c.period}`;
  console.log(`\n${id}: ${email}`);
  await L.signup(email, `Test ${i + 1}`);
  const page = await br.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await L.siteLogin(page, email);
    const btn = page.getByRole("button", { name: `Choose ${label} ${c.period === "annual" ? "yearly" : "monthly"}` });
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await L.payCheckout(page, "4242424242424242", async () => {
      await L.shot(page, `${id}-checkout`, `3a · ${label} ${c.period === "annual" ? "yearly" : "monthly"} — Stripe test Checkout filled with 4242 4242 4242 4242 (${email})`);
    });
    await page.waitForURL(/localhost:5174\/\?subscribed=1/, { timeout: 60000 });
    const lic = await L.waitFor(async () => {
      const rows = await L.db(`SELECT l.id, l.plan, l.active, l.expires_at, l.stripe_subscription_id, l.stripe_customer_id, l.extra_stations, l.listener_addons FROM licenses l JOIN users u ON u.license_key_id = l.id WHERE u.email = '${email}'`);
      return rows[0] && rows[0].stripe_subscription_id ? rows[0] : null;
    }, 60000);
    await page.reload();
    await page.waitForSelector(".hero");
    await page.waitForTimeout(1500);
    await L.shot(page, `${id}-account`, `3a · ${label} ${c.period === "annual" ? "yearly" : "monthly"} — account site after paying (${email}): ${lic ? `license ${lic.id}, plan ${lic.plan}` : "NO LICENSE"}`);
    const me = await L.api("GET", "/api/user/me", null, await L.signup(email));
    const ent = me.body && me.body.entitlements;
    const expectLimits = ENT.entitlementsFor({ id: 1, plan: c.plan, active: true }, { catalog: CATALOG, exemptIds: new Set() }).limits;
    const problems = [];
    if (!lic) problems.push("no license was linked to the account");
    else {
      if (lic.plan !== c.plan) problems.push(`license plan is ${lic.plan}, expected ${c.plan}`);
      if (lic.active !== true) problems.push(`license active=${lic.active}`);
      if (lic.expires_at) problems.push(`license has expires_at ${lic.expires_at} (a paid license must have none)`);
    }
    if (!ent || ent.plan !== c.plan || ent.status !== "active") problems.push(`entitlements: plan ${ent && ent.plan}, status ${ent && ent.status}`);
    if (ent && JSON.stringify(ent.limits) !== JSON.stringify(expectLimits)) problems.push(`limits ${JSON.stringify(ent.limits)} ≠ catalog ${JSON.stringify(expectLimits)}`);
    let sub = null;
    if (lic) {
      const { s } = L.stripe();
      sub = await s.subscriptions.retrieve(lic.stripe_subscription_id);
      const item = sub.items.data[0];
      const want = c.period === "annual" ? "year" : "month";
      if (item.price.recurring.interval !== want) problems.push(`Stripe interval ${item.price.recurring.interval}, expected ${want}`);
      if (item.price.unit_amount !== Math.round((c.period === "annual" ? CATALOG.plans[c.plan].price_annual : CATALOG.plans[c.plan].price_monthly) * 100)) problems.push(`Stripe amount ${item.price.unit_amount}`);
    }
    const result = { email, license: lic, entitlements: ent && { plan: ent.plan, label: ent.label, status: ent.status, limits: ent.limits },
      stripe: sub && { id: sub.id, status: sub.status, amount: sub.items.data[0].price.unit_amount, interval: sub.items.data[0].price.recurring.interval },
      pass: problems.length === 0, problems };
    L.record(id, result);
    console.log(`  ${result.pass ? "PASS" : "FAIL"} ${problems.join("; ")}`);
    console.log(`  license ${JSON.stringify(lic)}\n  limits ${JSON.stringify(ent && ent.limits)}`);
  } catch (e) {
    await L.shot(page, `${id}-error`, `3a · ${label} ${c.period} — the run stopped here: ${e.message.split("\n")[0]}`).catch(() => {});
    L.record(id, { email, pass: false, problems: [`driver error: ${e.message.split("\n")[0]}`] });
    console.log(`  ERROR ${e.message.split("\n")[0]}`);
  } finally { await page.close(); }
}

(async () => {
  const start = Number(process.argv[2] || 0), count = Number(process.argv[3] || CASES.length);
  const br = await L.browser();
  try { for (let i = start; i < Math.min(CASES.length, start + count); i++) await one(br, i, CASES[i]); }
  finally { await br.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
