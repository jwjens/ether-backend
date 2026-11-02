'use strict';
// A screenshot of the local account site's welcome page for one account (not part of the report).
//   node billing-test/shot-account.js <email> <out.png>
const L = require("./lib");
(async () => {
  const br = await L.browser();
  const page = await br.newPage({ viewport: { width: 1280, height: 900 } });
  await L.siteLogin(page, process.argv[2]);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: process.argv[3], fullPage: true });
  console.log((await page.evaluate(() => document.body.innerText.slice(0, 700))).replace(/\n+/g, " | "));
  await br.close();
})().catch((e) => { console.error("ERR", e.message.split("\n")[0]); process.exit(1); });
