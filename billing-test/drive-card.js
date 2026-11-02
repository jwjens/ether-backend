'use strict';
// Put a Stripe TEST card on test10's test-clock customer as the card future invoices are charged to:
//   node billing-test/drive-card.js pm_card_chargeCustomerFail   (4000 0000 0000 0341: attaches, every charge fails)
//   node billing-test/drive-card.js pm_card_visa                 (4242 4242 4242 4242)
// Sets it as the customer's invoice default AND the subscription's default (Checkout set the first card on the
// subscription, which wins over the customer's).
const fs = require("node:fs");
const path = require("node:path");
const L = require("./lib");
(async () => {
  const st = JSON.parse(fs.readFileSync(path.join(__dirname, "d-state.json"), "utf8"));
  const { s } = L.stripe();
  const pm = await s.paymentMethods.attach(process.argv[2], { customer: st.customer });
  await s.customers.update(st.customer, { invoice_settings: { default_payment_method: pm.id } });
  await s.subscriptions.update(st.subscription, { default_payment_method: pm.id });
  const out = { payment_method: pm.id, brand: pm.card.brand, last4: pm.card.last4, exp: `${pm.card.exp_month}/${pm.card.exp_year}` };
  L.record(`card-${pm.card.last4}`, out);
  console.log(JSON.stringify(out));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
