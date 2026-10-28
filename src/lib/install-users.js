'use strict';
// src/lib/install-users.js — a desktop computer mirrors its console users (name + PIN) up to account_users, so the same
// people can sign in to the dashboard and the Park page. POST /api/account/users/sync (x-license-key).
//
// THE FLIP (Jeff, 2026-10-27: "a computer's full list only adds or updates users; a user is removed only by an explicit
// removal"). The old rule revoked every install-origin user MISSING from the pushed list. An account runs on several
// computers, each pushing its own list, so the account's users swapped to whoever pushed last (jeff / Steve / Donavon
// revoked and recreated many times since September — docs/backend-deploy-compat-4.6.61-2026-10-20.md).
//
// NOW
//   users:   [{ name, role, pin_hash }]  → add or update (install-origin rows only). Absence means nothing.
//   removed: [name]                      → revoke that install-origin user. Only an explicit name removes anyone.
// A name in both lists is kept (the add/update wins): a computer never removes someone it is also sending.
// Older desktops send only `users`, so under this rule they can add and update but never remove — no computer has to be
// updated for the flip to stop.
//
// A dashboard-managed username (origin 'dashboard') is never touched by either list.

function normUsername(u)    { return typeof u === "string" ? u.trim() : ""; }
function isValidUsername(u) { return /^[A-Za-z0-9 ._-]{1,32}$/.test(u); }

async function syncInstallUsers(db, licenseId, body) {
  const incoming = Array.isArray(body?.users) ? body.users : [];
  const removals = Array.isArray(body?.removed) ? body.removed : [];
  let created = 0, updated = 0, skipped = 0, revoked = 0;
  const sent = new Set();

  for (const u of incoming) {
    const username = normUsername(u?.name);
    const pin_hash = typeof u?.pin_hash === "string" && u.pin_hash ? u.pin_hash : null;
    if (!isValidUsername(username) || !pin_hash) { skipped++; continue; }
    const role = u?.role === "admin" ? "admin" : "user";
    sent.add(username.toLowerCase());

    const { rows } = await db.query(
      `SELECT id, origin FROM account_users
       WHERE license_key_id = $1 AND lower(username) = lower($2) AND deleted_at IS NULL`,
      [licenseId, username]
    );
    if (rows.length === 0) {
      await db.query(
        `INSERT INTO account_users (license_key_id, username, display_name, role, pin_hash, origin)
         VALUES ($1, $2, $2, $3, $4, 'install')`,
        [licenseId, username, role, pin_hash]
      );
      created++;
    } else if (rows[0].origin === "install") {
      await db.query(
        `UPDATE account_users SET pin_hash = $1, role = $2, display_name = $3, updated_at = NOW() WHERE id = $4`,
        [pin_hash, role, username, rows[0].id]
      );
      updated++;
    } else {
      skipped++; // dashboard-managed username — leave it alone
    }
  }

  for (const n of removals) {
    const username = normUsername(n);
    if (!isValidUsername(username) || sent.has(username.toLowerCase())) continue;
    const r = await db.query(
      `UPDATE account_users SET deleted_at = NOW(), updated_at = NOW()
       WHERE license_key_id = $1 AND origin = 'install' AND deleted_at IS NULL AND lower(username) = lower($2)`,
      [licenseId, username]
    );
    revoked += r.rowCount;
  }

  return { ok: true, created, updated, skipped, revoked };
}

module.exports = { syncInstallUsers };
