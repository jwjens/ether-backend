'use strict';
// Reload the EtherCast window (no audio measurement), then print the screen.
const L = require("./lib");
(async () => {
  let { br, page } = await L.appPage();
  await page.reload(); await br.close();
  await new Promise((r) => setTimeout(r, Number(process.env.WAIT || 15000)));
  ({ br, page } = await L.appPage());
  await page.screenshot({ path: require("node:path").join(__dirname, "look.png") });
  console.log((await page.evaluate(() => document.body.innerText.slice(0, 500))).replace(/\n+/g, " | "));
  await br.close();
})().catch((e) => { console.error("ERR", e.message.split("\n")[0]); process.exit(1); });
