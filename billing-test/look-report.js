'use strict';
// Render report.html headless and save the top of it to billing-test/look.png (a check, not part of the report).
const path = require("node:path");
const L = require("./lib");
(async () => {
  const br = await L.browser();
  const page = await br.newPage({ viewport: { width: 1200, height: 1400 } });
  await page.goto(require("node:url").pathToFileURL(path.join(__dirname, "report.html")).href);
  await page.screenshot({ path: path.join(__dirname, "look.png") });
  const imgs = await page.evaluate(() => [...document.images].length);
  const broken = await page.evaluate(async () => { const a = [...document.images]; for (const i of a) { i.loading = "eager"; } await new Promise((r) => setTimeout(r, 3000)); return a.filter((i) => !i.naturalWidth).map((i) => i.src.split("/").pop()); });
  console.log({ imgs, broken });
  await br.close();
})();
