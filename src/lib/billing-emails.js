'use strict';
// BILLING EMAILS (docs/billing-notices-today-2026-10-31.md, desktop repo): the same notice the banners show
// (src/lib/billing-notice.js), emailed once per kind per period. The hourly job in index.js start() runs this ONLY when
// the Railway variable BILLING_EMAILS=1 — off by default, so a deploy sends nothing until Jeff turns it on.
//
// ONCE: billing_notices_sent (license_id, kind, period_key) is claimed BEFORE sending; a failed send gives the claim
// back so the next hour tries again. period_key is the notice's own (the trial's end day, the day the payment failed,
// the card's expiry month, …), so a new failure or a new card is a new period.
//
// FRESH ONLY: a notice whose state began more than FRESH_DAYS ago is not emailed. Turning the job on must not send
// "your trial ended" to an account whose trial ended last spring — only states that start from now on (and the last
// FRESH_DAYS) get an email. The banner still shows either way.
//
// Exempt, lifetime and platform-created licenses never get one (billingNotice returns null for them).
const { billingNotice } = require("./billing-notice");

const FRESH_DAYS = 30;
const DAY = 86400000;

/**
 * @param deps { pool, catalog, accountUrl, send(to, notice) → Promise, now?, exemptIds?, log? }
 * @returns {{ sent: Array<{ to, kind, license_id, period_key }>, failed: number }}
 */
async function runBillingEmails({ pool, catalog, accountUrl, send, now = Date.now(), exemptIds, log = console, freshDays = FRESH_DAYS }) {
  const licenses = (await pool.query(`SELECT * FROM licenses WHERE active = true`)).rows;
  const users = (await pool.query(`SELECT id, email, license_key_id, trial_ends_at FROM users ORDER BY id`)).rows;
  const userEmailByLicense = new Map();
  for (const u of users) if (u.license_key_id != null && u.email && !userEmailByLicense.has(Number(u.license_key_id))) userEmailByLicense.set(Number(u.license_key_id), u.email);

  const jobs = [];
  for (const lic of licenses) {
    const notice = billingNotice({ license: lic, catalog, now, accountUrl, ...(exemptIds ? { exemptIds } : {}) });
    const to = lic.email || userEmailByLicense.get(Number(lic.id));
    if (notice && to) jobs.push({ license_id: Number(lic.id), period_key: notice.period_key, to, notice });
  }
  for (const u of users) {
    if (u.license_key_id != null || !u.trial_ends_at || !u.email) continue;
    const notice = billingNotice({ user: u, catalog, now, accountUrl, ...(exemptIds ? { exemptIds } : {}) });
    if (notice) jobs.push({ license_id: 0, period_key: `user:${u.id}:${notice.period_key}`, to: u.email, notice });
  }

  const out = { sent: [], failed: 0 };
  for (const j of jobs) {
    if (now - new Date(j.notice.started_at).getTime() > freshDays * DAY) continue;
    const claim = await pool.query(
      `INSERT INTO billing_notices_sent (license_id, kind, period_key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING license_id`,
      [j.license_id, j.notice.kind, j.period_key]);
    if (!claim.rows.length) continue;   // already sent for this period
    try {
      await send(j.to, j.notice);
      out.sent.push({ to: j.to, kind: j.notice.kind, license_id: j.license_id, period_key: j.period_key });
    } catch (e) {
      out.failed++;
      log.warn(`[billing-emails] ${j.notice.kind} to license ${j.license_id} not sent (will retry next hour): ${e.message}`);
      await pool.query(`DELETE FROM billing_notices_sent WHERE license_id = $1 AND kind = $2 AND period_key = $3`,
        [j.license_id, j.notice.kind, j.period_key]).catch(() => {});
    }
  }
  if (out.sent.length || out.failed) log.log(`[billing-emails] sent ${out.sent.length}, failed ${out.failed}`);
  return out;
}

/** True when the hourly job may run: Railway variable BILLING_EMAILS=1. Anything else (unset, 0, true) = off. */
const billingEmailsOn = (env = process.env) => env.BILLING_EMAILS === "1";

module.exports = { runBillingEmails, billingEmailsOn, FRESH_DAYS };
