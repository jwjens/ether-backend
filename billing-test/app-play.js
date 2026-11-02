'use strict';
// Put the billing-test tone (billing-test/audio/billing-test-tone-60min.mp3, 440 Hz at about -26 dB) on deck A of
// station 1 in the test EtherCast and play it; start the per-second level log in the page (lib.installLevelLog).
const path = require("node:path");
const L = require("./lib");
(async () => {
  const { br, page } = await L.appPage();
  const fp = path.join(__dirname, "audio", "billing-test-tone-60min.mp3");
  const r = await page.evaluate(async (fp) => {
    const a = window.ether.audio;
    const loaded = await a.load("A", fp, "Billing test tone (440 Hz)", "Ether billing test", 0, 1);
    await new Promise((x) => setTimeout(x, 1500));
    const played = await a.play("A", 1);
    await new Promise((x) => setTimeout(x, 2500));
    return { loaded, played, state: await a.getState(1), levels: await a.getLevels(1) };
  }, fp);
  console.log(JSON.stringify(r, null, 1).slice(0, 2500));
  await L.installLevelLog(page);
  await page.waitForTimeout(4000);
  const rows = await L.drainLevels(page, "d2-start");
  console.log("level samples:", JSON.stringify(rows.map((x) => ({ t: new Date(x.t).toISOString(), peak: x.peak, callbacks: x.callbacks }))));
  await br.close();
})().catch((e) => { console.error("ERR", e.message.split("\n")[0]); process.exit(1); });
