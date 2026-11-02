'use strict';
// Look at the EtherCast window: text on screen + an unnumbered capture to billing-test/look.png (not part of the report).
const L = require("./lib");
(async () => {
  const { br, page } = await L.appPage();
  await page.screenshot({ path: require("path").join(__dirname, "look.png") });
  const txt = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log(txt);
  await br.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
