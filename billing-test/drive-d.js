'use strict';
// STEP 3d / 3e stages on test10@ether.test's Stripe TEST CLOCK (state from drive-d1.js, billing-test/d-state.json).
//   node billing-test/drive-d.js <stage-id> [--advance <ISO>] [--expect <notice-kind|none>] [--expect-status <status>] "<caption>"
// Each stage: optionally move the test clock to <ISO> (and the local server's clock with it — the grace and notice
// rules read the server's Date.now()), wait for Stripe's webhooks and the app's next /account/connect check (about
// every 20 s), then record the license row, the account's entitlements and notice, the subscription and its latest
// invoice, and the audio log; capture the EtherCast window (the popup, if any) and the account page.
const fs = require("node:fs");
const path = require("node:path");
const L = require("./lib");
const STATE = path.join(__dirname, "d-state.json");

const args = process.argv.slice(2);
const stage = args[0];
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const caption = args.filter((a, i) => i > 0 && !a.startsWith("--") && !["--advance", "--expect", "--expect-status", "--server-at"].includes(args[i - 1])).pop() || stage;

async function setServerClock(ms) {
  const r = await fetch(`${L.CTL}/clock`, { method: "POST", body: JSON.stringify({ now: ms }) });
  return r.json();
}

(async () => {
  const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const { s } = L.stripe();
  const out = { stage };
  const problems = [];
  const { br: abr, page: app } = await L.appPage();
  const br = await L.browser();
  const page = await br.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    // The server stays on REAL time while Stripe's clock moves and its webhooks arrive: the webhook signature check
    // refuses a timestamp more than 5 minutes from the server's time. Only afterwards is the server's clock set for
    // the capture (--server-at: an ISO time, or +<days> from real now). Stripe stamps test-clock events with the REAL
    // time, so grace is counted from the real moment of the failure, not the test clock's date.
    await setServerClock(null);
    const target = opt("--advance");
    if (target) {
      const t = Math.floor(Date.parse(target) / 1000);
      await s.testHelpers.testClocks.advance(st.clock, { frozen_time: t });
      const ready = await L.waitFor(async () => { const c = await s.testHelpers.testClocks.retrieve(st.clock); return c.status === "ready" ? c : null; }, 180000, 2000);
      if (!ready) throw new Error("test clock did not become ready in 3 minutes");
      await app.waitForTimeout(Number(process.env.WEBHOOK_MS || 30000));   // webhooks land on real time
    }
    out.clock = new Date((await s.testHelpers.testClocks.retrieve(st.clock)).frozen_time * 1000).toISOString();
    const at = opt("--server-at");
    const serverMs = !at ? null : /^\+\d+(\.\d+)?$/.test(at) ? Date.now() + Number(at.slice(1)) * 86400000 : Date.parse(at);
    out.server_clock = (await setServerClock(serverMs)).now;
    // webhooks land, then the app's next account check (about every 20 s) picks up the notice
    await app.waitForTimeout(Number(process.env.SETTLE_MS || 45000));
    const lic = (await L.db(`SELECT id, plan, active, expires_at, grace_until, payment_failed_at, card_last4, card_exp_month, card_exp_year, stripe_subscription_id FROM licenses WHERE id = ${st.license_id}`))[0];
    const me = await L.api("GET", "/api/user/me", null, await L.signup(st.email));
    const ent = me.body && me.body.entitlements;
    const notice = me.body && me.body.account && me.body.account.billing_notice;
    const sub = await s.subscriptions.retrieve(st.subscription, { expand: ["latest_invoice"] }).catch((e) => ({ error: e.message }));
    const popup = await app.evaluate(() => {
      const el = document.querySelector("[data-billing-kind]");
      return el ? { kind: el.getAttribute("data-billing-kind"), text: el.innerText.split("\n").filter(Boolean).join(" | ") } : null;
    });
    const levels = await L.drainLevels(app, stage);
    const audio = levels.length ? {
      samples: levels.length, from: new Date(levels[0].t).toISOString(), to: new Date(levels[levels.length - 1].t).toISOString(),
      deckA_not_playing: levels.filter((r) => r.deckA !== "playing").length,
      // a stall = at least half a second passed and the engine rendered no new frames (two reads ms apart can show the same count)
      frames_stalled: levels.filter((r, i) => i > 0 && r.t - levels[i - 1].t >= 500 && !(r.frames_total > levels[i - 1].frames_total)).length,
      errors: levels.filter((r) => r.error).length,
      frames: [levels[0].frames_total, levels[levels.length - 1].frames_total],
    } : { samples: 0 };
    Object.assign(out, {
      license: lic, entitlements: ent && { status: ent.status, plan: ent.plan, level: ent.level, cloud: ent.cloud, grace_until: ent.grace_until },
      notice: notice && { kind: notice.kind, title: notice.title }, popup, audio,
      subscription: sub.error ? sub : { status: sub.status, cancel_at_period_end: sub.cancel_at_period_end,
        latest_invoice: sub.latest_invoice && { id: sub.latest_invoice.id, status: sub.latest_invoice.status, attempt_count: sub.latest_invoice.attempt_count, amount_due: sub.latest_invoice.amount_due } },
    });
    const kindTxt = popup ? `popup "${popup.kind}": ${popup.text.slice(0, 160)}` : "no popup";
    const audioTxt = audio.samples ? `audio: ${audio.samples} one-second samples since the last stage, deck A playing in ${audio.samples - audio.deckA_not_playing}, output frames advancing in ${audio.samples - 1 - audio.frames_stalled} of ${audio.samples - 1}` : "audio: no samples";
    await L.shot(app, `${stage}-app`, `${caption} — EtherCast (Stripe test clock ${out.clock.slice(0, 16)}Z, server ${out.server_clock.slice(0, 16)}Z): ${kindTxt}; license ${lic.id}: ${ent && ent.status}, grace_until ${lic.grace_until ? new Date(lic.grace_until).toISOString().slice(0, 10) : "none"}; ${audioTxt}`, { fullPage: false });
    await L.siteLogin(page, st.email);
    await page.waitForTimeout(1200);
    await L.shot(page, `${stage}-account`, `${caption} — account page: notice ${notice ? `"${notice.title}"` : "none"}; subscription ${sub.status || sub.error}`);

    const want = opt("--expect");
    if (want) {
      const got = notice ? notice.kind : "none";
      if (got !== want) problems.push(`notice: ${got}, expected ${want}`);
      const gotPopup = popup ? popup.kind : "none";
      if (gotPopup !== want) problems.push(`app popup: ${gotPopup}, expected ${want}`);
    }
    const wantStatus = opt("--expect-status");
    if (wantStatus && (!ent || ent.status !== wantStatus)) problems.push(`entitlement status ${ent && ent.status}, expected ${wantStatus}`);
    if (lic.active !== true) problems.push(`license active=${lic.active} (must never be switched off)`);
    if (audio.samples && (audio.deckA_not_playing || audio.frames_stalled || audio.errors)) problems.push(`audio: deck A not playing in ${audio.deckA_not_playing} samples, frames stalled in ${audio.frames_stalled}, errors ${audio.errors}`);
  } catch (e) {
    await L.shot(app, `${stage}-error`, `${stage} — the run stopped here: ${e.message.split("\n")[0]}`, { fullPage: false }).catch(() => {});
    problems.push(`driver error: ${e.message.split("\n")[0]}`);
  }
  out.pass = problems.length === 0; out.problems = problems;
  L.record(stage, out);
  console.log(JSON.stringify(out, null, 1));
  await br.close(); await abr.close();
})();
