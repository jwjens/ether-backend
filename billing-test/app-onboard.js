'use strict';
// Sign the test EtherCast in as a fresh account and walk its first-run screens to the main screen, the way a person
// does (the same screens as run 2, in one script): sign in → name the station → Standard → Radio Station → details →
// skip music → profile + PIN → pick the profile → Start my shift → skip the tour → music licensing notice.
//   node billing-test/app-onboard.js <email>
const path = require("node:path");
const L = require("./lib");

(async () => {
  const email = process.argv[2];
  const { br, page } = await L.appPage();
  const wait = (ms) => page.waitForTimeout(ms);
  // a click from inside the page (run 2: an overlay sometimes swallowed pointer clicks)
  const clickText = async (re, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = await page.evaluate((src) => {
        const r = new RegExp(src, "i");
        const el = [...document.querySelectorAll("button, [role=button], div, span")].reverse()
          .find((e) => e.offsetParent !== null && r.test((e.innerText || "").trim()) && (e.innerText || "").trim().length < 60);
        if (!el) return false;
        (el.closest("button") || el).click(); return true;
      }, re.source);
      if (hit) return;
      await wait(500);
    }
    throw new Error(`not found on screen: ${re}`);
  };
  const step = async (name, fn) => { await fn(); console.log(`  ✓ ${name}`); };

  await step("sign in", async () => {
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', L.PASSWORD);
    await page.locator('button:has-text("Sign in")').last().click();
    await page.waitForSelector('input[placeholder="98.5 The Wave"]', { timeout: 60000 });
  });
  await step("name the station", async () => { await page.fill('input[placeholder="98.5 The Wave"]', "Billing Rerun FM"); await clickText(/^Create station$/); await wait(4000); });
  await step("layout: Standard", async () => { await clickText(/^Standard/); await clickText(/^Continue$/); await wait(2000); });
  await step("persona: Radio Station", async () => { await clickText(/^Radio Station/); await clickText(/^Continue$/); await wait(3000); });
  await step("station details", async () => { await clickText(/^Continue$/); await wait(6000); });
  await step("skip music", async () => { await clickText(/^Skip for now/); await page.waitForSelector('input[placeholder="Admin"]', { timeout: 60000 }); });
  await step("profile + PIN", async () => {
    await page.fill('input[placeholder="Admin"]', "Tester");
    const pins = page.locator('input[type="password"]');
    await pins.nth(0).fill("1234"); await pins.nth(1).fill("1234");
    await clickText(/^Create profile & continue$/);
    await wait(12000);
  });
  await step("pick the profile, start the shift", async () => {
    await clickText(/^TT\s*Tester$/);
    await wait(800);
    await clickText(/^START MY SHIFT/);
    await wait(8000);
  });
  for (const [name, re] of [["skip the tour", /^Skip tour$/], ["music licensing notice", /^I Understand$/]]) {
    await step(name, async () => { await clickText(re, 15000).catch(() => console.log(`    (${name}: not shown)`)); await wait(2000); });
  }
  await page.screenshot({ path: path.join(__dirname, "look.png") });
  console.log((await page.evaluate(() => document.body.innerText.slice(0, 300))).replace(/\n+/g, " | "));
  await br.close();
})().catch((e) => { console.error("ERR", e.message.split("\n")[0]); process.exit(1); });
