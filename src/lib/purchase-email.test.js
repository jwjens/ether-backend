'use strict';
// The thank-you email after a purchase: plan + price for the period, Mac/Windows downloads (the account site's links),
// how to start, the account site; the key only for a buyer with no account.
const test = require("node:test");
const assert = require("node:assert");
const { purchaseEmail } = require("./purchase-email");
const catalog = require("./plans").load();
const base = { catalog, accountUrl: "https://signup.ether-cast.com/", apiUrl: "https://api.example.test/" };

test("an account-site purchase: plan and monthly price, both downloads, sign in with the same email and password, account button", () => {
  const m = purchaseEmail({ ...base, plan: "station", period: "monthly", hasAccount: true });
  assert.strictEqual(m.subject, "Welcome to Ether Live 128");
  assert.match(m.bodyHtml, /Ether Live 128<\/strong> \(\$25\/month, billed monthly\)/);
  assert.match(m.bodyHtml, /href="https:\/\/api\.example\.test\/download\/mac"[^>]*>Download for Mac</);
  assert.match(m.bodyHtml, /href="https:\/\/api\.example\.test\/download\/windows"[^>]*>Download for Windows</);
  assert.match(m.bodyHtml, /install Ether, then sign in with the same email and password/);
  assert.deepStrictEqual(m.button, { label: "Open your account", url: "https://signup.ether-cast.com" });
  assert.doesNotMatch(m.bodyHtml, /license key/i, "no key for someone who signs in with email and password");
});

test("a yearly purchase shows the yearly price", () => {
  const m = purchaseEmail({ ...base, plan: "unlimited", period: "annual" });
  assert.strictEqual(m.subject, "Welcome to Ether Network");
  assert.match(m.bodyHtml, /\(\$790\/year, billed yearly\)/);
});

test("a buyer without an account (old payment link): told to create the account first, and given the key", () => {
  const m = purchaseEmail({ ...base, plan: "pro", period: "monthly", hasAccount: false, licenseKey: "ETH-PRO-AAAA-<b>" });
  assert.match(m.bodyHtml, /create your Ether account at <a href="https:\/\/signup\.ether-cast\.com"/);
  assert.match(m.bodyHtml, /ETH-PRO-AAAA-&lt;b&gt;/, "the key, escaped");
});

test("the download links are the account site's (API /download/<os>, which always serves the newest release)", () => {
  const site = require("node:fs").readFileSync("C:/ether-signup/src/components/AccountView.tsx", "utf8");
  assert.match(site, /const DL_MAC = `\$\{API_BASE\}\/download\/mac`;/);
  assert.match(site, /const DL_WIN = `\$\{API_BASE\}\/download\/windows`;/);
  const m = purchaseEmail({ ...base, plan: "local" });
  assert.deepStrictEqual([m.links.mac, m.links.windows], ["https://api.example.test/download/mac", "https://api.example.test/download/windows"]);
});
