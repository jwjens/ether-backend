'use strict';
// The whole audio log (billing-test/audio-levels.jsonl): per stage and in total — samples, deck A not playing, output
// frames not advancing for at least half a second, errors; and each window reload's frame count across it.
const fs = require("node:fs");
const path = require("node:path");
const rows = fs.readFileSync(path.join(__dirname, process.env.BT_LEVELS || "audio-levels.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const samples = rows.filter((r) => r.stage !== "window-reload" && r.frames_total != null);
const reloads = rows.filter((r) => r.stage === "window-reload");
const t = (r) => Date.parse(r.at);
const stall = (r, i, a) => i > 0 && t(r) - t(a[i - 1]) >= 500 && !(r.frames_total > a[i - 1].frames_total) && r.stage === a[i - 1].stage;
const byStage = {};
samples.forEach((r, i, a) => {
  const s = (byStage[r.stage] ||= { samples: 0, not_playing: 0, stalls: 0, errors: 0, from: r.at, to: r.at });
  s.samples++; s.to = r.at;
  if (r.deckA !== "playing") s.not_playing++;
  if (stall(r, i, a)) s.stalls++;
  if (r.error) s.errors++;
});
const total = { samples: samples.length, from: samples[0].at, to: samples[samples.length - 1].at,
  not_playing: samples.filter((r) => r.deckA !== "playing").length, stalls: samples.filter(stall).length,
  errors: samples.filter((r) => r.error).length, device_errors_max: Math.max(...samples.map((r) => r.device_errors || 0)),
  frames: [samples[0].frames_total, samples[samples.length - 1].frames_total],
  reloads: reloads.map((r) => ({ at: r.at, seconds: r.seconds, frames_rendered: r.frames_rendered, per_second: Math.round(r.frames_rendered / r.seconds), deckA: [r.before.deckA, r.after.deckA] })) };
const out = { total, byStage };
fs.writeFileSync(path.join(__dirname, (process.env.BT_LEVELS || "audio-levels.jsonl").replace("audio-levels", "audio-summary").replace(".jsonl", ".json")), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
