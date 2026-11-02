'use strict';
// One action in the EtherCast window, then print the screen's text (billing-test/look.png = an unnumbered capture).
//   node billing-test/app-do.js signin <email>
//   node billing-test/app-do.js click "<visible text>"
//   node billing-test/app-do.js fill "<css selector>" "<value>"
//   node billing-test/app-do.js eval "<js expression>"
const L = require("./lib");
(async () => {
  const [cmd, a, b] = process.argv.slice(2);
  const { br, page } = await L.appPage();
  if (cmd === "signin") {
    await page.fill('input[type="email"]', a);
    await page.fill('input[type="password"]', L.PASSWORD);
    await page.locator('button:has-text("Sign in")').last().click();
  } else if (cmd === "click") await page.getByText(a, { exact: true }).first().click();
  else if (cmd === "fill") await page.fill(a, b);
  else if (cmd === "eval") console.log(JSON.stringify(await page.evaluate(a), null, 1));
  await page.waitForTimeout(Number(process.env.WAIT || 3000));
  await page.screenshot({ path: require("path").join(__dirname, "look.png") });
  console.log("---- screen ----\n" + (await page.evaluate(() => document.body.innerText.slice(0, 1800))));
  await br.close();
})().catch((e) => { console.error("ERR", e.message.split("\n")[0]); process.exit(1); });
