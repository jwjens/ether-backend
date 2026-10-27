'use strict';
// src/lib/seat-tiers.js — how many machines a license may run on. DATA, not code (Jeff, 2026-10-26: "seat limits are data,
// not code ... each license has a seat limit, with an Unlimited tier").
//
// This replaces two hard-coded rules that disagreed: SEATS_MAX = 5 (the /account/* sign-in path) and
// PLAN_MACHINE_LIMITS = { free: 1 } ?? 5 (/validate, desktop-activate, the activation lists). The owner could not sign in a
// sixth machine on his own license.
//
// THE MODEL
//   seat_tiers(id, name, seat_limit, is_default, default_for_plan)   seat_limit NULL = Unlimited
//   licenses.seat_tier_id                                              NULL = "the default for this license"
// A license's tier: its own seat_tier_id if set; else the tier whose default_for_plan is its plan; else the is_default tier.
// The column is added EMPTY and nothing is backfilled, so no existing license row is written by this change.
//
// FAIL CLOSED. A license that resolves to no tier at all is refused a NEW seat (error seat_tier_missing) — never granted
// unlimited by accident. Machines already seated keep working either way.
//
// NEVER compare a count with seat_limit directly: in JavaScript `4 >= null` is true, so an Unlimited tier would lock
// everyone out. atSeatLimit() is the one comparison.

/** Create the table + column, and seed the tiers ONCE (only when the table is empty). The seed reproduces exactly what
 *  the two old constants did, so no license's limit changes on deploy; after that the owner edits them as data. */
async function ensureSeatTiers(db) {
  const { rows: had } = await db.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'seat_tiers'`);
  if (!had.length) await db.query(`
    CREATE TABLE IF NOT EXISTS seat_tiers (
      id               SERIAL PRIMARY KEY,
      name             TEXT NOT NULL UNIQUE,
      seat_limit       INTEGER CHECK (seat_limit IS NULL OR seat_limit >= 0),
      is_default       BOOLEAN NOT NULL DEFAULT false,
      default_for_plan TEXT UNIQUE,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )`);
  // One default tier: the only writer of is_default (PATCH /api/platform/seat-tiers/:id) clears the others in the same
  // transaction.
  await db.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS seat_tier_id INTEGER REFERENCES seat_tiers(id)`);
  const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM seat_tiers`);
  if (rows[0].n === 0) {
    await db.query(
      `INSERT INTO seat_tiers (name, seat_limit, is_default, default_for_plan) VALUES
         ('Standard', 5, true, NULL),
         ('Free', 1, false, 'free'),
         ('Unlimited', NULL, false, NULL)`);
    console.log("[seat-tiers] seeded: Standard (5, default), Free (1, plan free), Unlimited");
  }
}

/** Pure: the tier a license resolves to, or null. */
function pickSeatTier(license, tiers) {
  if (!license) return null;
  const list = tiers || [];
  if (license.seat_tier_id != null) {
    const own = list.find(t => t.id === license.seat_tier_id);
    if (own) return own;
  }
  const byPlan = list.find(t => t.default_for_plan != null && t.default_for_plan === license.plan);
  if (byPlan) return byPlan;
  return list.find(t => t.is_default) || null;
}

/** Pure: would one more machine exceed the tier? No tier → true (fail closed). Unlimited → never. */
function atSeatLimit(used, tier) {
  if (!tier) return true;
  if (tier.seat_limit == null) return false;
  return Number(used) >= Number(tier.seat_limit);
}

/** The fields every response that reports a limit carries. seats_max is null for Unlimited, with seats_unlimited: true
 *  beside it, so a client can never read null as zero. */
function seatFields(tier) {
  return {
    seats_max: tier ? tier.seat_limit : null,
    seats_unlimited: !!tier && tier.seat_limit == null,
    seat_tier: tier ? tier.name : null,
  };
}

/** The tier for one license id (or an already-loaded license row with id/plan/seat_tier_id). */
async function seatTierFor(db, licenseOrId) {
  let lic = licenseOrId;
  if (typeof licenseOrId !== "object" || licenseOrId == null || !("seat_tier_id" in licenseOrId)) {
    const id = typeof licenseOrId === "object" && licenseOrId ? licenseOrId.id : licenseOrId;
    const { rows } = await db.query(`SELECT id, plan, seat_tier_id FROM licenses WHERE id = $1`, [id]);
    lic = rows[0];
  }
  if (!lic) return null;
  const { rows: tiers } = await db.query(`SELECT id, name, seat_limit, is_default, default_for_plan FROM seat_tiers`);
  return pickSeatTier(lic, tiers);
}

/** The refusal every seat-consuming endpoint sends when a tier is missing or full. */
function seatRefusal(tier, used, extra = {}) {
  if (!tier) {
    return { error: "seat_tier_missing", detail: "This license has no seat tier and there is no default tier. The platform owner must set one.", seats_used: used, ...seatFields(null), ...extra };
  }
  return { error: "seat_limit_reached", seats_used: used, ...seatFields(tier), ...extra };
}

module.exports = { ensureSeatTiers, pickSeatTier, atSeatLimit, seatFields, seatTierFor, seatRefusal };
