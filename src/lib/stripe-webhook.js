'use strict';
// src/lib/stripe-webhook.js — what a verified PLATFORM Stripe event does to licenses (P0 billing blockers,
// docs/paywall-entitlements-plan.md §0 in the desktop repo). The route in index.js verifies the signature and drops
// connected-account events; everything after that lives here so it can be tested against real SQL.
//
// B1  The prod `licenses` table has NO `stripe_sub_id` column — it has `stripe_subscription_id` + `stripe_customer_id`
//     (the table predates the CREATE TABLE in index.js). Every statement here uses the real columns; before this,
//     every one of them failed with `column "stripe_sub_id" does not exist`.
// B2  invoice.payment_failed used `event.data.object.id` — the INVOICE id — as the subscription id, so it never
//     matched. The subscription is resolved from the invoice now. A failed payment does NOT revoke: under the agreed
//     lifecycle (grace 7/30/90) the account stays active while Stripe retries; access ends when Stripe cancels the
//     subscription (customer.subscription.deleted) or marks it unpaid/canceled (customer.subscription.updated).
//     Persisting a past_due state arrives with the P2 `subscriptions` table.
// B3  customer.subscription.updated was not handled, so a portal plan change never reached licenses.plan.

// Subscription id from a Stripe object: a subscription (its own id), an invoice (several API-version shapes), or a
// checkout session. Returns null when none can be found — never the object's own non-subscription id.
function subscriptionIdOf(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.object === "subscription") return obj.id || null;
  const pick = (v) => (typeof v === "string" ? v : v && typeof v === "object" && v.id ? v.id : null);
  return pick(obj.subscription)
    || pick(obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription)
    || pick(obj.lines && obj.lines.data && obj.lines.data[0] && obj.lines.data[0].subscription)
    || null;
}

// Price id on an invoice line (older API: line.price.id; newer: line.pricing.price_details.price).
function invoicePriceIdOf(obj) {
  const line = obj && obj.lines && obj.lines.data && obj.lines.data[0];
  if (!line) return "";
  return (line.price && line.price.id)
    || (line.pricing && line.pricing.price_details && line.pricing.price_details.price)
    || "";
}

// Price id on a subscription object (items.data[0].price.id).
function subscriptionPriceIdOf(sub) {
  const it = sub && sub.items && sub.items.data && sub.items.data[0];
  return (it && it.price && it.price.id) || "";
}

const customerIdOf = (obj) => (typeof obj?.customer === "string" ? obj.customer : obj?.customer?.id) || null;

// Subscription status → what it does to licenses.active. null = leave it (grace: Stripe is still retrying).
function activeForStatus(status) {
  if (status === "active" || status === "trialing") return true;
  if (status === "canceled" || status === "unpaid" || status === "incomplete_expired") return false;
  return null;   // past_due, incomplete, paused, unknown → unchanged
}

/**
 * Apply one verified platform event. deps: { pool, validPlans:Set, planByPriceId:{}, generateLicenseKey(plan),
 * hashKey(key)→Promise<hash>, sendLicenseEmail(email,key,plan)→Promise, log?:{log,warn,error} }.
 * Returns { status, body } — the route sends exactly that.
 */
async function handlePlatformEvent(event, deps) {
  const { pool, validPlans, planByPriceId, generateLicenseKey, hashKey, sendLicenseEmail } = deps;
  const log = deps.log || console;
  const obj = (event && event.data && event.data.object) || {};
  const ok = (extra = {}) => ({ status: 200, body: { received: true, ...extra } });

  // ── Branch A: account-linked checkout (signup app; client_reference_id = users.id) ──
  if (event.type === "checkout.session.completed" && obj.client_reference_id) {
    const userId = parseInt(obj.client_reference_id, 10);
    const email = (obj.customer_details?.email || obj.customer_email || "").toLowerCase().trim();
    const plan = obj.metadata?.plan;
    const subId = obj.subscription ? subscriptionIdOf(obj) : obj.id;
    const customerId = customerIdOf(obj);
    if (!(userId && plan && validPlans.has(plan))) {
      log.warn(`[Stripe] account checkout missing userId/plan (ref=${obj.client_reference_id}, plan=${plan})`);
      return ok();
    }
    const { rows: existing } = await pool.query("SELECT id FROM licenses WHERE stripe_subscription_id = $1", [subId]);
    let licId;
    if (existing.length) {
      await pool.query(
        "UPDATE licenses SET active = true, plan = $1, email = $2, stripe_customer_id = COALESCE($3, stripe_customer_id) WHERE id = $4",
        [plan, email || null, customerId, existing[0].id]);
      licId = existing[0].id;
    } else {
      const key = generateLicenseKey(plan);
      const r = await pool.query(
        `INSERT INTO licenses (email, plan, stripe_subscription_id, stripe_customer_id, key_prefix, key_hash)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [email || null, plan, subId, customerId, key.slice(0, 12), await hashKey(key)]);
      licId = r.rows[0].id;
    }
    await pool.query("UPDATE users SET license_key_id = $1 WHERE id = $2", [licId, userId]);
    log.log(`[Stripe] account subscription: user ${userId} → license ${licId} (${plan})`);
    return ok();
  }

  // ── Branch B: payment-link purchase / renewal → license by email ──
  if (event.type === "checkout.session.completed" || event.type === "invoice.payment_succeeded") {
    const email = (obj.customer_email || obj.customer_details?.email || "").toLowerCase().trim();
    const subId = event.type === "invoice.payment_succeeded" ? subscriptionIdOf(obj) : (obj.subscription ? subscriptionIdOf(obj) : obj.id);
    const customerId = customerIdOf(obj);
    if (!email) { log.warn("[Stripe] No email"); return ok(); }
    if (!subId) { log.error(`[Stripe] ${event.type} for ${email} carries no subscription id — no license issued`); return ok(); }
    const priceId = invoicePriceIdOf(obj);
    const plan = planByPriceId[priceId];
    if (!plan) {
      log.error(`[Stripe] UNKNOWN priceId "${priceId}" for ${email} (event: ${event.type}, subId: ${subId}) — no license issued. ` +
        `Acknowledging webhook to prevent retry. Operator must issue manually.`);
      return ok();
    }
    const { rows: existing } = await pool.query("SELECT id, license_key FROM licenses WHERE stripe_subscription_id = $1", [subId]);
    if (existing.length) {
      await pool.query(
        "UPDATE licenses SET active = true, email = $1, stripe_customer_id = COALESCE($2, stripe_customer_id) WHERE id = $3",
        [email, customerId, existing[0].id]);
      log.log(`[License] Reactivated license ${existing[0].id} → ${email}`);
      return ok();
    }
    const licenseKey = generateLicenseKey(plan);
    const keyHash = await hashKey(licenseKey);   // before BEGIN — keeps the tx window short
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query(
        `INSERT INTO licenses (email, plan, stripe_subscription_id, stripe_customer_id, key_prefix, key_hash)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [email, plan, subId, customerId, licenseKey.slice(0, 12), keyHash]);
      await sendLicenseEmail(email, licenseKey, plan);
      await tx.query("COMMIT");
      log.log(`[License] Issued: ${licenseKey.slice(0, 12)}... → ${email} (${plan})`);
      return ok();
    } catch (e) {
      await tx.query("ROLLBACK").catch(() => {});
      log.error("[License] Issue+email failed, rolled back:", e.message);
      // Explicit non-2xx so Stripe retries with backoff (the old code threw out of an async handler and left the
      // request hanging until a timeout — same retry, worse signal).
      return { status: 500, body: { error: "license_issue_failed" } };
    } finally { tx.release(); }
  }

  // ── B3: plan / status change (portal upgrade-downgrade, Stripe dunning outcome) ──
  if (event.type === "customer.subscription.updated") {
    const subId = subscriptionIdOf(obj);
    if (!subId) return ok();
    const priceId = subscriptionPriceIdOf(obj);
    const plan = priceId ? planByPriceId[priceId] || null : null;
    if (priceId && !plan) log.error(`[Stripe] subscription.updated ${subId}: UNKNOWN priceId "${priceId}" — plan left unchanged`);
    const active = activeForStatus(obj.status);
    const r = await pool.query(
      `UPDATE licenses
          SET plan   = COALESCE($2, plan),
              active = COALESCE($3, active),
              stripe_customer_id = COALESCE($4, stripe_customer_id)
        WHERE stripe_subscription_id = $1`,
      [subId, plan, active, customerIdOf(obj)]);
    log.log(`[Stripe] subscription.updated ${subId}: status=${obj.status} plan=${plan || "(unchanged)"} active=${active === null ? "(unchanged)" : active} rows=${r.rowCount}`);
    return ok({ updated: r.rowCount });
  }

  // ── Cancellation: access ends ──
  if (event.type === "customer.subscription.deleted") {
    const subId = subscriptionIdOf(obj);
    const r = subId
      ? await pool.query("UPDATE licenses SET active = false WHERE stripe_subscription_id = $1", [subId])
      : { rowCount: 0 };
    log.log(`[License] Deactivated sub ${subId} (${r.rowCount} rows)`);
    return ok({ deactivated: r.rowCount });
  }

  // ── B2: failed payment → grace, not revocation ──
  if (event.type === "invoice.payment_failed") {
    const subId = subscriptionIdOf(obj);
    log.warn(`[Stripe] payment failed: invoice ${obj.id} subscription ${subId || "(none)"} — access kept during grace; ` +
      `revoked only when Stripe cancels or marks the subscription unpaid`);
    return ok({ grace: true, subscription: subId });
  }

  return ok();
}

module.exports = { handlePlatformEvent, subscriptionIdOf, invoicePriceIdOf, subscriptionPriceIdOf, activeForStatus };
