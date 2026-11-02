'use strict';
// THE THANK-YOU EMAIL AFTER A PURCHASE (Jeff, 2026-11-01). Before this, a purchase on the account site sent no email at
// all, and the old payment-link email gave a license key with outdated steps ("Studio → Enter License Key") and no
// downloads. Sent ONCE per subscription, by whichever webhook branch makes the license (src/lib/stripe-webhook.js).
//
//   · the plan bought, with its price for the period bought (monthly or yearly)
//   · Download for Mac / Download for Windows — the same links as the account site's buttons
//     (API_PUBLIC_URL/download/<os>, which always redirects to the newest release)
//   · how to start: install Ether, then sign in with the same email and password
//   · a button to the account site
// A buyer with no account yet (an old payment link) is told to create the account with this email and confirm it — the
// license links to it automatically once confirmed (src/lib/issued-license.js). NO KEY in any customer email (Jeff,
// 2026-11-01: the email is the license; keys are internal).
// issuedLicenseEmail: the email for a license issued in the platform (a new license, or an existing account's new plan).
// Pure: returns the subject and the body for the standard email shell (emailShell in index.js).

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function priceText(planDef, period) {
  return period === "annual" ? `$${planDef.price_annual}/year` : `$${planDef.price_monthly}/month`;
}

function downloadButton(label, url) {
  return `<a href="${esc(url)}" style="display:inline-block;background:#6040C0;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 18px;border-radius:8px;margin:0 8px 8px 0">${esc(label)}</a>`;
}

/**
 * @param {object} a
 * @param {object} a.catalog     config/plans.json
 * @param {string} a.plan        plan key (local | station | pro | unlimited)
 * @param {string} [a.period]    monthly | annual
 * @param {string} a.accountUrl  the account site (ACCOUNT_APP_URL)
 * @param {string} a.apiUrl      the backend's public URL (API_PUBLIC_URL) — the download links
 * @param {boolean} [a.hasAccount] the buyer has an account (email + password) on the account site
 * @returns {{ subject, heading, bodyHtml, button, links: { mac, windows, account } }}
 */
function purchaseEmail({ catalog, plan, period = "monthly", accountUrl, apiUrl, hasAccount = true }) {
  const def = catalog.plans[plan] || catalog.plans.station;
  const label = def.label;
  const api = String(apiUrl || "").replace(/\/$/, "");
  const account = String(accountUrl || "").replace(/\/$/, "");
  const links = { mac: `${api}/download/mac`, windows: `${api}/download/windows`, account };
  const p = (html) => `<p style="margin:0 0 16px">${html}</p>`;
  const start = hasAccount
    ? p(`<strong style="color:#18181b">To start:</strong> install Ether, then sign in with the same email and password you use for your account.`)
    : p(`<strong style="color:#18181b">To start:</strong> ${createSteps(account)}`);
  const bodyHtml =
      p(`Thanks for subscribing to <strong style="color:#18181b">Ether ${esc(label)}</strong> (${esc(priceText(def, period))}${period === "annual" ? ", billed yearly" : ", billed monthly"}).`)
    + `<div style="margin:0 0 8px">${downloadButton("Download for Mac", links.mac)}${downloadButton("Download for Windows", links.windows)}</div>`
    + p(`<span style="font-size:12px;color:#8a8a96">The links always download the latest version of Ether.</span>`)
    + start
    + p(`Your plan, card and add-ons are on your account page.`);
  return {
    subject: `Welcome to Ether ${label}`,
    heading: `Welcome to Ether ${label}`,
    bodyHtml,
    button: { label: "Open your account", url: account },
    links,
  };
}

// Jeff's words (2026-11-01) for someone without an account yet.
function createSteps(account) {
  const link = `<a href="${esc(account)}" style="color:#6040C0">${esc(account.replace(/^https?:\/\//, ""))}</a>`;
  return `Create your account at ${link} with this email address, confirm it, then install Ether and sign in.`;
}

/**
 * The email for a license issued in the platform. No key. A new license (no account yet): "Your Ether license is ready.
 * Create your account at … with this email address, confirm it, then install Ether and sign in." An existing account that
 * now has the plan: "Your Ether account is now on the … plan. Open Ether and sign in with this email address."
 */
function issuedLicenseEmail({ planLabel, accountExists = false, accountUrl, apiUrl }) {
  const api = String(apiUrl || "").replace(/\/$/, "");
  const account = String(accountUrl || "").replace(/\/$/, "");
  const links = { mac: `${api}/download/mac`, windows: `${api}/download/windows`, account };
  const p = (html) => `<p style="margin:0 0 16px">${html}</p>`;
  const lead = accountExists
    ? p(`Your Ether account is now on the <strong style="color:#18181b">${esc(planLabel)}</strong> plan. Open Ether and sign in with this email address.`)
    : p(`Your Ether license is ready.`) + p(createSteps(account));
  const bodyHtml = lead
    + `<div style="margin:0 0 8px">${downloadButton("Download for Mac", links.mac)}${downloadButton("Download for Windows", links.windows)}</div>`
    + p(`<span style="font-size:12px;color:#8a8a96">The links always download the latest version of Ether.</span>`);
  return accountExists
    ? { subject: `Your Ether account is now on ${planLabel}`, heading: `You're on Ether ${planLabel}`, bodyHtml, button: { label: "Open your account", url: account }, links }
    : { subject: `Your Ether license is ready`, heading: `Your Ether ${planLabel} license is ready`, bodyHtml, button: { label: "Create your account", url: account }, links };
}

module.exports = { purchaseEmail, issuedLicenseEmail, priceText };
