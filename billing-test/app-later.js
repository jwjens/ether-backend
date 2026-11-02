'use strict';
// Click "Later" on the billing popup in the test EtherCast (what a person does to close it); report what was closed.
const L = require("./lib");
(async () => {
  const { br, page } = await L.appPage();
  const r = await page.evaluate(() => {
    const p = document.querySelector("[data-billing-kind]");
    if (!p) return { closed: null };
    const kind = p.getAttribute("data-billing-kind");
    const b = [...p.querySelectorAll("button")].find((x) => x.innerText.trim() === "Later");
    b.click();
    return { closed: kind, at: new Date().toISOString() };
  });
  await page.waitForTimeout(1000);
  r.popup_after = await page.evaluate(() => !!document.querySelector("[data-billing-kind]"));
  require("node:fs").appendFileSync(L.LEVELS, JSON.stringify({ stage: "later-clicked", ...r }) + "\n");
  console.log(JSON.stringify(r));
  await br.close();
})().catch((e) => { console.error("ERR", e.message.split("\n")[0]); process.exit(1); });
