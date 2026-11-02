'use strict';
// Pay test10's open (declined) invoice with the card now on file — what "Update card" then paying does.
const fs = require("node:fs");
const path = require("node:path");
const L = require("./lib");
(async () => {
  const st = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.BT_STATE || "d-state.json"), "utf8"));
  const { s } = L.stripe();
  const sub = await s.subscriptions.retrieve(st.subscription);
  const inv = await s.invoices.pay(typeof sub.latest_invoice === "string" ? sub.latest_invoice : sub.latest_invoice.id);
  const after = await s.subscriptions.retrieve(st.subscription);
  const out = { invoice: inv.id, invoice_status: inv.status, amount_paid: inv.amount_paid, subscription_status: after.status };
  L.record("d6-pay-open-invoice", out);
  console.log(JSON.stringify(out));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
