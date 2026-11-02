'use strict';
// The in-app profile screen after a window reload: click the Tester profile and type its PIN (1234).
const L = require("./lib");
(async () => {
  const { br, page } = await L.appPage();
  await page.getByText("Tester", { exact: true }).first().click({ force: true });
  await page.waitForTimeout(1500);
  await page.keyboard.type("1234", { delay: 120 });
  await page.waitForTimeout(800);
  await page.keyboard.press("Enter").catch(() => {});
  await page.waitForTimeout(6000);
  await page.screenshot({ path: require("path").join(__dirname, "look.png") });
  console.log(await page.evaluate(() => document.body.innerText.slice(0, 400)));
  await br.close();
})().catch((e) => { console.error("ERR", e.message.split("\n")[0]); process.exit(1); });
