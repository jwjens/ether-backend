'use strict';
// Re-deliver Stripe TEST events the local server refused, exactly as Stripe sent them (fetched by id from Stripe test
// mode), signed with the test webhook secret the way Stripe signs (t=<now>, v1=HMAC-SHA256(secret, "t.payload")), to
// the LOCAL webhook only, in the order given.
//   node billing-test/replay-events.js evt_1 evt_2 …
// Why (2026-11-01): the test's server-clock control moved the time the webhook signature check uses, so these were
// refused with 400 "Timestamp outside the tolerance zone" — a test-tool fault, never sent to the product.
const crypto = require("node:crypto");
const L = require("./lib");

(async () => {
  const { s, env } = L.stripe();
  const secret = String(env.STRIPE_WEBHOOK_SECRET || "");
  if (!secret.startsWith("whsec_")) throw new Error("no STRIPE_WEBHOOK_SECRET in .env.stripe-test");
  const clock = await (await fetch(`${L.CTL}/clock`)).json();
  if (clock.offset_ms !== 0) throw new Error(`the server clock is moved (${clock.now}); set it back to real time first`);
  const out = [];
  for (const id of process.argv.slice(2)) {
    const ev = await s.events.retrieve(id);
    const payload = JSON.stringify(ev);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
    const r = await fetch(`${L.API}/webhook/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` }, body: payload });
    const row = { id, type: ev.type, created: new Date(ev.created * 1000).toISOString(), status: r.status, body: (await r.text()).slice(0, 120) };
    out.push(row);
    console.log(JSON.stringify(row));
  }
  L.record(`replay-${Date.now()}`, { replayed: out });
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
