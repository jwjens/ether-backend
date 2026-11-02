'use strict';
// One-off: what Stripe's hosted Checkout page offers for choosing "Card" (selectors for lib.js payCheckout).
const L = require("./lib");
(async () => {
  const token = await L.signup("probe@ether.test", "Probe");
  const r = await L.api("POST", "/api/user/checkout", { plan: "local", period: "monthly" }, token);
  const br = await L.browser();
  const page = await br.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(r.body.url);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => [...document.querySelectorAll("input[type=radio], button, [role=radio], [data-testid]")]
    .filter((e) => /card/i.test((e.id || "") + " " + (e.getAttribute("data-testid") || "") + " " + (e.getAttribute("aria-label") || "") + " " + (e.value || "")))
    .slice(0, 20).map((e) => `${e.tagName} id=${e.id} testid=${e.getAttribute("data-testid")} value=${e.value} aria=${e.getAttribute("aria-label")}`));
  console.log(info.join("\n"));
  await br.close();
})();
