'use strict';
// STEP 3e — cancel test10's subscription at the end of its paid period (what a customer-portal cancel does).
const fs = require("node:fs");
const path = require("node:path");
const L = require("./lib");
(async () => {
  const st = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.BT_STATE || "d-state.json"), "utf8"));
  const { s } = L.stripe();
  const sub = await s.subscriptions.update(st.subscription, { cancel_at_period_end: true });
  const end = sub.cancel_at || sub.current_period_end || sub.items.data[0].current_period_end;
  const out = { subscription: sub.id, status: sub.status, cancel_at_period_end: sub.cancel_at_period_end, ends: new Date(end * 1000).toISOString() };
  L.record("e1-cancel-request", out);
  console.log(JSON.stringify(out));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
