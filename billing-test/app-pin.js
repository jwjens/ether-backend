'use strict';
// Fill the first-run profile PIN boxes with a test PIN (1234) and create the profile.
const L = require("./lib");
(async () => {
  const { br, page } = await L.appPage();
  const pins = page.locator('input[type="password"]');
  await pins.nth(0).fill("1234"); await pins.nth(1).fill("1234");
  await page.getByText("Create profile & continue", { exact: true }).click();
  await page.waitForTimeout(15000);
  await page.screenshot({ path: require("path").join(__dirname, "look.png") });
  console.log((await page.evaluate(() => document.body.innerText.slice(0, 1500))));
  await br.close();
})().catch((e) => { console.error("ERR", e.message.split("\n")[0]); process.exit(1); });
