'use strict';
// Install the per-second level log in the running app (idempotent) and/or drain it to audio-levels.jsonl.
//   node billing-test/app-levels.js <stage>
const L = require("./lib");
(async () => {
  const { br, page } = await L.appPage();
  await L.installLevelLog(page);
  await page.waitForTimeout(Number(process.env.WAIT || 0));
  const rows = await L.drainLevels(page, process.argv[2] || "check");
  const last = rows.slice(-3);
  console.log(`${rows.length} samples; last: ${JSON.stringify(last)}`);
  await br.close();
})().catch((e) => { console.error("ERR", e.message.split("\n")[0]); process.exit(1); });
