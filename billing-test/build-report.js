'use strict';
// STEP 4 — billing-test/report.html: the PASS/FAIL list per path at the top (plain words; each FAIL says what happened
// and what was expected), then every screenshot at its real size, in order, with its one-line caption.
//   node billing-test/build-report.js
const fs = require("node:fs");
const path = require("node:path");

const DIR = __dirname;
const SCREENS = path.join(DIR, "screens");
const captions = JSON.parse(fs.readFileSync(path.join(SCREENS, "captions.json"), "utf8"));
const results = JSON.parse(fs.readFileSync(path.join(DIR, "results.json"), "utf8"));
const audio = JSON.parse(fs.readFileSync(path.join(DIR, "audio-summary.json"), "utf8")).total;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pngSize = (f) => { const b = fs.readFileSync(f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
const ok = (id) => results[id] && results[id].pass === true;

// Screens taken while something outside the product was wrong — said under the caption, never hidden.
const NOTES = {
  "027-d3-card-expiring-app.png": "No popup: after a fresh sign-in the app never checked the account again until it was reopened (FAIL 2 above).",
  "031-d4-renewal-failed-app.png": "Taken while my test's server-clock tool made the server refuse Stripe's webhooks (\"Timestamp outside the tolerance zone\"), so the failed payment had not reached the server yet. A test-tool fault: the 7 refused events were replayed exactly as Stripe sent them; 033–036 are the result.",
  "032-d4-renewal-failed-account.png": "Same as 031: webhooks refused by the test tool at this moment.",
  "033-d4b-grace-app.png": "Server right (grace), but no popup: the earlier popup had closed today, and a new notice waits up to a day (FAIL 3 above).",
  "043-e2-ended-app.png": "Server right (grace), but no popup — the once-a-day rule again (FAIL 3 above). 045 is after reopening.",
};

const A = [["local", "monthly"], ["local", "annual"], ["station", "monthly"], ["station", "annual"], ["pro", "monthly"], ["pro", "annual"], ["unlimited", "monthly"], ["unlimited", "annual"]];
const LABEL = { local: "Local", station: "Live 128", pro: "Live 320", unlimited: "Network" };
const rows = [];
const P = (path_, pass, what) => rows.push({ path: path_, pass, what });

for (const [p, per] of A) {
  const r = results[`a-${p}-${per}`];
  P(`3a · ${LABEL[p]} ${per === "annual" ? "yearly" : "monthly"} with 4242`, ok(`a-${p}-${per}`),
    r && r.pass ? `License ${r.license.id} on ${r.email}: plan ${r.license.plan}, active, no end date; limits match the catalog; Stripe charges $${r.stripe.amount / 100} per ${r.stripe.interval}.` : `Expected a paid license. Happened: ${r ? r.problems.join("; ") : "not run"}`);
}
const b = results["b-network-addons"];
P("3b · Network + 1 extra station, then + 1 Listener add-on", ok("b-network-addons"),
  b && b.pass ? "Stations 5 → 6 and listener pool 250 → 300 after the extra station; pool 350 after the Listener add-on. Stripe subscription $79 + $15 + $10." : `Happened: ${b ? b.problems.join("; ") : "not run"}`);
const c = results["c-card-refusals"];
P("3c · Declined card 0002 at Checkout", ok("c-card-refusals"), c ? `Refused: "${c.steps[0].message}". No subscription, no license; the account keeps its trial.` : "not run");
P("3c · Expired card 0069 at Checkout", ok("c-card-refusals"), c ? `Refused: "${c.steps[1].message}". No subscription, no license. (Stripe will not store either card, so neither can reach a license or the app; the in-app "update your card" popup is shown by the 0341 path in 3d.)` : "not run");
P("3d · Card expiring — server notice", ok("d3b-card-expiring"), "\"Your card expires soon — Your Visa ending 4242 expires at the end of December 2026\" (Stripe clock Dec 3, renewal paid on Dec 2).");
P("3d · Card expiring — popup in the app right after signing in", false, "Happened: no popup (027). After a fresh sign-in the app checked the account once and never again until it was reopened (server log: 1 check in about 30 minutes). Expected: the app checks about every 20 seconds and shows the popup. After reopening the window it checked every 20 s and the popup showed (029).");
P("3d · Failed renewal with 0341 → grace", ok("d4c-grace-popup"), "Renewal declined; license stays active with a grace end 7 days after the failure. Popup and account page: \"Your payment didn't go through — cloud features included until November 9, 2026\" with Update card (035).");
P("3d · Grace popup appears by itself", false, "Happened: no popup until Ether was reopened (033). An earlier popup had closed the same day, and the popup shows at most once a day after the first. Expected: the \"update your card\" popup shows when the payment fails. (My clock change made the earlier popup close; a real user who clicks Later on \"card expires soon\" and then has a payment fail that day would see the same.)");
P("3d · Grace over → lapsed", ok("d5-lapsed"), "\"Your plan has lapsed … The grace period ended on November 9, 2026\". The license is still active and the key still signs in; only cloud features stop (037).");
P("3d · Card updated to 4242, open invoice paid → active", ok("d6-paid-again"), "Invoice paid ($25); grace and the failure cleared; license active; popup gone (039).");
P("3c/3d/3e · Audio never stops", audio.not_playing === 0 && audio.stalls === 0 && audio.errors === 0,
  `${audio.samples} one-second samples, ${audio.from.slice(11, 19)}–${audio.to.slice(11, 19)} UTC: deck A "playing" in every one; the engine's output frame counter advanced every second (${(audio.frames[1] - audio.frames[0]).toLocaleString("en-US")} frames ≈ 44,300 a second); 0 device errors. Across each of the ${audio.reloads.length} window reloads: ${audio.reloads.map((r) => `${r.frames_rendered.toLocaleString("en-US")} frames in ${r.seconds.toFixed(1)} s`).join(", ")}.`);
P("3e · Cancel at the end of the period", ok("e1-cancel-requested"), "Still active until the paid period ends (Feb 2) (041).");
P("3e · Period ends → Stripe ends the subscription → grace", ok("e2b-ended-popup"), "License never switched off; \"Your plan ended — cloud features included until November 9, 2026\" with Choose a plan; account page says \"Subscription ended · Live 128\" and offers the plans (045, 046). The popup again needed a reopen (043, FAIL above).");
P("3e · Grace over after cancel → lapsed", ok("e3-lapsed"), "\"Your plan has lapsed\"; the key still signs in (047).");
P("Purchase makes exactly one license", false, "Happened: one Live 128 purchase (test10) made TWO licenses for the same subscription — license 1 (linked to the account) and license 2 (not linked; its key was emailed). Stripe sent checkout.session.completed and invoice.payment_succeeded at the same moment; both webhook branches looked for the subscription, found none, and each created a license. Expected: one license per subscription. Production has the same race (no unique rule on the subscription id). Not fixed here: a fix touches the production schema.");

const passN = rows.filter((r) => r.pass).length;
const shots = Object.keys(captions).filter((f) => fs.existsSync(path.join(SCREENS, f))).sort();

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Billing Test Report</title>
<style>
:root{--bg:#ffffff;--fg:#1b1b22;--muted:#5d5d6b;--line:#e3e3ea;--card:#f6f6f9;--pass:#167a3e;--passbg:#e6f4ec;--fail:#b3261e;--failbg:#fbe9e7;--accent:#6040c0}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#0d0d12;--fg:#ececf2;--muted:#a3a3b3;--line:#2a2a36;--card:#16161e;--pass:#5fd08a;--passbg:#12301f;--fail:#ff8a80;--failbg:#3a1714;--accent:#8868d8}}
:root[data-theme="dark"]{--bg:#0d0d12;--fg:#ececf2;--muted:#a3a3b3;--line:#2a2a36;--card:#16161e;--pass:#5fd08a;--passbg:#12301f;--fail:#ff8a80;--failbg:#3a1714;--accent:#8868d8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:36px 0 12px;border-bottom:1px solid var(--line);padding-bottom:6px}
.sub{color:var(--muted);margin:0 0 20px}.sum{display:inline-block;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin-bottom:16px}
ul.pf{list-style:none;padding:0;margin:0}ul.pf li{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:0 0 8px;background:var(--card)}
.tag{display:inline-block;font-weight:700;font-size:12px;letter-spacing:.04em;border-radius:4px;padding:1px 7px;margin-right:8px}
.p .tag{color:var(--pass);background:var(--passbg)}.f .tag{color:var(--fail);background:var(--failbg)}.path{font-weight:600}.what{display:block;color:var(--muted);margin-top:3px}
figure{margin:0 0 28px}figcaption{margin:0 0 8px}figcaption b{color:var(--accent)}.note{display:block;color:var(--fail);font-size:14px;margin-top:2px}
.shot{overflow-x:auto;border:1px solid var(--line);border-radius:6px;background:var(--card)}.shot img{display:block;max-width:none}
.notes li{margin-bottom:6px}code{font-size:13px}
</style></head><body><main>
<h1>Billing test — Stripe test mode, local server</h1>
<p class="sub">Run 2, 2026-11-01 (US Pacific evening; times below are UTC). Stripe TEST mode only; local server on a fresh in-memory database; nothing live, no real accounts or licenses. Test accounts test1–test10@ether.test, their Stripe test customers and the test products are kept.</p>
<div class="sum"><b>${passN} PASS</b> · <b>${rows.length - passN} FAIL</b> of ${rows.length} paths</div>
<h2>PASS / FAIL by path</h2>
<ul class="pf">${rows.map((r) => `<li class="${r.pass ? "p" : "f"}"><span class="tag">${r.pass ? "PASS" : "FAIL"}</span><span class="path">${esc(r.path)}</span><span class="what">${esc(r.what)}</span></li>`).join("")}</ul>
<h2>How the test ran (read before the screens)</h2>
<ul class="notes">
<li>The grace fix built first (backend <code>9c9699c</code>): a failed payment or an ended subscription puts a paid license into a 7-day grace period, then lapsed. Stripe never switches a license off, so the key always signs in.</li>
<li>3d and 3e ran on one account (test10) on a Stripe <b>test clock</b>. Stripe's clock moved Nov 2 → Dec 3 → Jan 2 → Jan 10 → Feb 3. The local server's clock was moved separately for the captures (a test-only control), because the server reads its own time.</li>
<li>Stripe stamps test-clock events with the <b>real</b> time, so grace is counted from the real moment of the failure: the notices say "declined on November 2, included until November 9" while Stripe's clock reads January. In production the two clocks are the same.</li>
<li>Card 0341 attaches but fails every charge, so it cannot pay the first invoice at Checkout. The first invoice was paid with 4242 (expiring 12/26, for the card-expiring stage), then 0341 was made the card on file before the renewal.</li>
<li>The test-clock customer's Checkout session was created by the test driver with the server's own settings (same line items, account link and metadata), because only a session made with that customer runs on its clock.</li>
<li>The EtherCast dev build ran in its own empty profile against the local server. A quiet 440 Hz tone was loaded straight into the audio engine on deck A, so the on-screen decks don't show a track; the engine's own counters are the audio proof.</li>
<li>Where the app needed reopening to show a popup, the window was reloaded (what reopening does for the screen). The audio engine is a separate process and kept playing through every reload.</li>
<li>Test-tool faults found and fixed during the run (not product faults): the test database helper handed a placeholder back as the license key; my server-clock control made the server refuse 7 Stripe webhooks, which were then replayed exactly as Stripe sent them.</li>
</ul>
<h2>Screens (real size, in order)</h2>
${shots.map((f) => { const s = pngSize(path.join(SCREENS, f)); return `<figure id="s${f.slice(0, 3)}"><figcaption><b>${f.slice(0, 3)}</b> ${esc(captions[f])}${NOTES[f] ? `<span class="note">${esc(NOTES[f])}</span>` : ""}</figcaption><div class="shot"><img src="screens/${esc(f)}" width="${s.w}" height="${s.h}" alt="${esc(captions[f])}" loading="lazy"></div></figure>`; }).join("\n")}
</main></body></html>
`;
fs.writeFileSync(path.join(DIR, "report.html"), html);
console.log(`report.html: ${rows.length} paths (${passN} pass, ${rows.length - passN} fail), ${shots.length} screens`);
