'use strict';
// src/lib/libraryGrants.js — single source of truth for cross-license library GRANTS.
//
// A grant lets a GRANTEE license READ an OWNER license's library (the install-scope
// songs/artists/albums catalog + its R2 audio under ${owner.id}/). Read-only and revocable.
// Used by BOTH the sync pull (src/routes/sync.js) and the /audio/* endpoints (src/index.js)
// so the grant rule lives in exactly one place.

// Owner license ids whose library this grantee license is approved to READ. Returns [] when
// there are no active grants → callers treat that as "self only" (no behavior change for the
// overwhelming majority of installs).
async function grantedOwnerLicenseIds(pool, granteeLicenseId) {
  const { rows } = await pool.query(
    `SELECT owner_license_id FROM library_grants
     WHERE grantee_license_id = $1 AND revoked_at IS NULL`,
    [granteeLicenseId]
  );
  return rows.map(r => r.owner_license_id);
}

// Resolve which license id's R2 prefix actually holds file_key, honoring read grants.
// Probes the caller's OWN prefix FIRST (so a grantee's own file always wins), then each
// granted owner's prefix, via objectExists(key) → Promise<bool> (a HeadObject probe).
// Returns the resolved license id, or null if the key is found under none of them.
//
// SECURITY: the only prefixes ever probed are the caller's own and ACTIVE-granted owners' —
// never an arbitrary license. An ungranted caller passes grantedOwnerIds=[], so it can only
// ever resolve its own prefix and never reaches another license's objects.
async function resolveAudioPrefixId(objectExists, callerLicenseId, grantedOwnerIds, file_key) {
  for (const id of [callerLicenseId, ...grantedOwnerIds]) {
    if (await objectExists(`${id}/${file_key}`)) return id;
  }
  return null;
}

module.exports = { grantedOwnerLicenseIds, resolveAudioPrefixId };
