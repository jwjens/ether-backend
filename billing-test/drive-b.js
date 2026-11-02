'use strict';
// STEP 3b — the Network monthly account (test7@ether.test, bought in 3a): add one extra station, then one Listener
// add-on, on the account site's Add-ons section. Checks the Stripe subscription items, the license columns (written by
// the webhook) and the limits the server hands out.
const L = require("./lib");

async function limits(email) {
  const me = await L.api("GET", "/api/user/me", null, await L.signup(email));
  return me.body.entitlements;
}
async function licRow(email) {
  return (await L.db(`SELECT l.id, l.plan, l.extra_stations, l.listener_addons, l.stripe_subscription_id FROM licenses l JOIN users u ON u.license_key_id = l.id WHERE u.email = '${email}'`))[0];
}

(async () => {
  const email = "test7@ether.test";
  const br = await L.browser();
  const page = await br.newPage({ viewport: { width: 1280, height: 900 } });
  const { s } = L.stripe();
  const out = { email, steps: [] };
  const problems = [];
  try {
    await L.siteLogin(page, email);
    await page.waitForSelector("#addons", { timeout: 20000 });
    const before = await limits(email);
    await L.shot(page, "b-network-addons-before", `3b · Network monthly (${email}) — Add-ons section before: 0 extra stations, 0 listener add-ons; pool ${before.limits.listeners.pool}, stations ${before.limits.stations_included}`);

    // 1. one extra station
    await page.fill("#addon-extra", "1");
    await page.click("text=Save add-ons");
    await page.waitForSelector("text=Saved.", { timeout: 30000 });
    const r1 = await L.waitFor(async () => { const r = await licRow(email); return r && r.extra_stations === 1 ? r : null; }, 30000);
    const l1 = await limits(email);
    await L.shot(page, "b-network-extra-station", `3b · after adding 1 extra station — license extra_stations=${r1 && r1.extra_stations}; pool ${l1.limits.listeners.pool} (was 250), stations ${l1.limits.stations_included} (was 5)`);
    if (!r1) problems.push("extra station: license extra_stations did not become 1");
    if (l1.limits.listeners.pool !== 300) problems.push(`extra station: pool ${l1.limits.listeners.pool}, expected 300`);
    if (l1.limits.stations_included !== 6) problems.push(`extra station: stations ${l1.limits.stations_included}, expected 6`);
    out.steps.push({ step: "extra station", license: r1, limits: l1.limits });

    // 2. one Listener add-on
    await page.reload(); await page.waitForSelector("#addons");
    await page.fill("#addon-listeners", "1");
    await page.click("text=Save add-ons");
    await page.waitForSelector("text=Saved.", { timeout: 30000 });
    const r2 = await L.waitFor(async () => { const r = await licRow(email); return r && r.listener_addons === 1 ? r : null; }, 30000);
    const l2 = await limits(email);
    await L.shot(page, "b-network-listener-addon", `3b · after adding 1 Listener add-on — license listener_addons=${r2 && r2.listener_addons}; pool ${l2.limits.listeners.pool} (expected 350), stations ${l2.limits.stations_included}`);
    if (!r2) problems.push("listener add-on: license listener_addons did not become 1");
    if (l2.limits.listeners.pool !== 350) problems.push(`listener add-on: pool ${l2.limits.listeners.pool}, expected 350`);
    if (l2.limits.stations_included !== 6) problems.push(`listener add-on: stations ${l2.limits.stations_included}, expected 6`);
    out.steps.push({ step: "listener add-on", license: r2, limits: l2.limits });

    const sub = await s.subscriptions.retrieve((r2 || r1).stripe_subscription_id);
    out.stripe_items = sub.items.data.map((it) => ({ price: it.price.id, nickname: it.price.product, amount: it.price.unit_amount, qty: it.quantity }));
    const amounts = sub.items.data.map((it) => `${it.price.unit_amount / 100}×${it.quantity}`).sort().join(", ");
    if (amounts !== "10×1, 15×1, 79×1") problems.push(`Stripe items ${amounts}, expected 79×1, 15×1, 10×1`);

    out.pass = problems.length === 0; out.problems = problems;
  } catch (e) {
    await L.shot(page, "b-error", `3b — the run stopped here: ${e.message.split("\n")[0]}`).catch(() => {});
    out.pass = false; out.problems = [...problems, `driver error: ${e.message.split("\n")[0]}`];
  }
  L.record("b-network-addons", out);
  console.log(JSON.stringify(out, null, 1));
  await br.close();
})();
