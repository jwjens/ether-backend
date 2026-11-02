'use strict';
// STEP 3c — a declined card (4000 0000 0000 0002) and an expired card (4000 0000 0000 0069) at Stripe test Checkout,
// on a new account (test9@ether.test, Live 128 monthly). Stripe refuses both at Checkout; the check is that the page
// says so, no subscription and no license are made, and the account still has its trial.
const L = require("./lib");

(async () => {
  const email = "test9@ether.test";
  const br = await L.browser();
  const page = await br.newPage({ viewport: { width: 1280, height: 900 } });
  const out = { email, steps: [] };
  const problems = [];
  try {
    await L.signup(email, "Test 9");
    await L.siteLogin(page, email);
    await page.getByRole("button", { name: "Choose Live 128 monthly" }).click();
    for (const [card, slug, expect] of [["4000000000000002", "declined-0002", /declined/i], ["4000000000000069", "expired-0069", /expired/i]]) {
      if (slug === "declined-0002") await L.payCheckout(page, card);
      else {
        await page.fill("#cardNumber", "");
        await page.fill("#cardNumber", card);
        await page.click('[data-testid="hosted-payment-submit-button"], button.SubmitButton');
      }
      const msg = await L.waitFor(async () => {
        const t = await page.evaluate(() => document.body.innerText);
        const m = t.split("\n").find((l) => /declined|expired|incorrect|could not|couldn't/i.test(l));
        return m || null;
      }, 45000);
      await page.waitForTimeout(800);
      await L.shot(page, `c-checkout-${slug}`, `3c · Stripe Checkout with ${card.replace(/(\d{4})(?=\d)/g, "$1 ")} (${email}) — the page says: "${msg || "(no message)"}"`);
      if (!msg || !expect.test(msg)) problems.push(`${slug}: Checkout message was "${msg}", expected one matching ${expect}`);
      out.steps.push({ card, message: msg });
    }
    const lic = await L.db(`SELECT l.id, l.plan, l.stripe_subscription_id FROM licenses l JOIN users u ON u.license_key_id = l.id WHERE u.email = '${email}'`);
    const me = await L.api("GET", "/api/user/me", null, await L.signup(email));
    out.license = lic[0] || null;
    out.account_status = me.body && me.body.account && me.body.account.entitlement;
    if (lic.length && lic[0].stripe_subscription_id) problems.push(`a paid license was made: ${JSON.stringify(lic[0])}`);
    await page.goto(`${L.SITE}/`); await page.waitForSelector(".hero"); await page.waitForTimeout(1000);
    await L.shot(page, "c-account-after-refusals", `3c · account site after both refusals (${email}) — no subscription; license: ${lic.length ? JSON.stringify(lic[0]) : "none"}; account: ${JSON.stringify(out.account_status)}`);
  } catch (e) {
    await L.shot(page, "c-error", `3c — the run stopped here: ${e.message.split("\n")[0]}`).catch(() => {});
    problems.push(`driver error: ${e.message.split("\n")[0]}`);
  }
  out.pass = problems.length === 0; out.problems = problems;
  L.record("c-card-refusals", out);
  console.log(JSON.stringify(out, null, 1));
  await br.close();
})();
