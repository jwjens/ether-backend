'use strict';
// Reload the EtherCast window (what reopening Ether does for the renderer; the audio engine is its own process and is
// not touched). Logs the engine's frame counter just before and after, so the report can show audio never stopped.
const L = require("./lib");
(async () => {
  let { br, page } = await L.appPage();
  await L.drainLevels(page, process.argv[2] || "before-reload");
  const before = await page.evaluate(async () => { const l = await window.ether.audio.getLevels(1); const s = await window.ether.audio.getState(1); return { t: Date.now(), frames: l.frames_total, deckA: s.deckA.status }; });
  await page.reload();
  await page.waitForTimeout(20000);
  await br.close();
  ({ br, page } = await L.appPage());
  const after = await page.evaluate(async () => { const l = await window.ether.audio.getLevels(1); const s = await window.ether.audio.getState(1); return { t: Date.now(), frames: l.frames_total, deckA: s.deckA.status }; });
  await L.installLevelLog(page);
  const secs = (after.t - before.t) / 1000, frames = after.frames - before.frames;
  console.log(JSON.stringify({ before, after, seconds: secs, frames_rendered: frames, frames_per_second: Math.round(frames / secs) }));
  require("node:fs").appendFileSync(L.LEVELS, JSON.stringify({ stage: "window-reload", at: new Date(after.t).toISOString(), before, after, seconds: secs, frames_rendered: frames }) + "\n");
  console.log("---- screen ----\n" + (await page.evaluate(() => document.body.innerText.slice(0, 600))));
  await br.close();
})().catch((e) => { console.error("ERR", e.message.split("\n")[0]); process.exit(1); });
