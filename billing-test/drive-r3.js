'use strict';
// RERUN of the failed path "one purchase makes exactly one license" on the FIXED server (BT_PORT, the rerun server).
//  A. The exact pair of Stripe TEST events that made two licenses in run 2 (test10's purchase:
//     checkout.session.completed + invoice.payment_succeeded, fetched from Stripe by id), delivered to the local webhook
//     at the same instant, signed with the test webhook secret — the race, made certain.
//  B. A normal purchase on the fixed server: test11@ether.test, Live 128 monthly, 4242, through the account site.
// Each: exactly one license for the subscription, the account linked to it, at most one key email.
const crypto = require("node:crypto");
const L = require("./lib");

const PAIR = ["evt_1UXANE9Zqn8ZGrIUOc67uvjq", "evt_1UXANF9Zqn8ZGrIUvAJQI006"];

async function post(ev, secret) {
  const payload = JSON.stringify(ev);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  const r = await fetch(`${L.API}/webhook/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` }, body: payload });
  return { type: ev.type, status: r.status, body: (await r.text()).slice(0, 160) };
}
const licensesFor = (sub) => L.db(`SELECT id, email, plan, active, stripe_subscription_id FROM licenses WHERE stripe_subscription_id = '${sub}' ORDER BY id`);

(async () => {
  const { s, env } = L.stripe();
  const problems = [];
  const out = {};
  const br = await L.browser();
  const page = await br.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    // A — the race, certain
    const evs = await Promise.all(PAIR.map((id) => s.events.retrieve(id)));
    const sub = evs[0].data.object.subscription;
    const emailsBefore = (await (await fetch(`${L.CTL}/emails`)).json()).length;
    const answers = await Promise.all(evs.map((e) => post(e, env.STRIPE_WEBHOOK_SECRET)));
    await new Promise((r) => setTimeout(r, 3000));
    const rowsA = await licensesFor(sub);
    const linkedA = await L.db(`SELECT id, email, license_key_id FROM users WHERE id = ${Number(evs[0].data.object.client_reference_id)}`);
    const keyEmailsA = (await (await fetch(`${L.CTL}/emails`)).json()).slice(emailsBefore);
    out.A = { events: PAIR, subscription: sub, answers, licenses: rowsA, linked_user: linkedA[0], emails_sent: keyEmailsA };
    if (rowsA.length !== 1) problems.push(`A: ${rowsA.length} licenses for ${sub}, expected 1`);
    if (!linkedA[0] || !rowsA[0] || linkedA[0].license_key_id !== rowsA[0].id) problems.push("A: the account is not linked to the one license");
    if (answers.some((a) => a.status !== 200)) problems.push(`A: webhook answers ${answers.map((a) => a.status).join(", ")}`);

    // B — a normal purchase on the fixed server
    const email = "test11@ether.test";
    await L.signup(email, "Test 11");
    await L.siteLogin(page, email);
    await page.getByRole("button", { name: "Choose Live 128 monthly" }).click();
    await L.payCheckout(page, "4242424242424242");
    await page.waitForURL((u) => u.href.startsWith(`${L.SITE}/?subscribed=1`), { timeout: 60000 });
    const lic = await L.waitFor(async () => (await L.db(`SELECT l.id, l.stripe_subscription_id FROM licenses l JOIN users u ON u.license_key_id = l.id WHERE u.email = '${email}'`))[0], 60000);
    await new Promise((r) => setTimeout(r, 8000));   // let every webhook of the purchase land
    const rowsB = lic ? await licensesFor(lic.stripe_subscription_id) : [];
    out.B = { email, subscription: lic && lic.stripe_subscription_id, licenses: rowsB };
    if (rowsB.length !== 1) problems.push(`B: ${rowsB.length} licenses for ${lic && lic.stripe_subscription_id}, expected 1`);
    await page.reload(); await page.waitForSelector(".hero"); await page.waitForTimeout(1000);
    await L.shot(page, "r3-purchase-one-license", `RERUN 3 · one license per subscription (fixed server) — (A) the exact pair of Stripe events that made two licenses in run 2, delivered at the same instant: ${rowsA.length} license (${rowsA.map((r) => r.id).join(", ")}), account linked, webhook answers ${answers.map((a) => a.status).join(" & ")}; (B) a new Live 128 purchase by ${email}: ${rowsB.length} license (${rowsB.map((r) => r.id).join(", ")})`);
  } catch (e) {
    await L.shot(page, "r3-error", `RERUN 3 — the run stopped here: ${e.message.split("\n")[0]}`).catch(() => {});
    problems.push(`driver error: ${e.message.split("\n")[0]}`);
  }
  out.pass = problems.length === 0; out.problems = problems;
  L.record("r3-one-license", out);
  console.log(JSON.stringify(out, null, 1));
  await br.close();
})();
