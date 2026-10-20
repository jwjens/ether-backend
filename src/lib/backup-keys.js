// src/lib/backup-keys.js — every DB backup of a license in R2, all pages, newest first by timestamp (2026-10-20).
// Keys: <license>/backups/<ts>.db.gz (account-wide, older desktops) or <license>/backups/<machine_id>/<ts>.db.gz (per
// computer). ListObjectsV2 returns at most 1,000 keys per call, so every page is read; the order is by the timestamp
// (the last path segment), because key text stops being chronological once keys carry a machine folder.
"use strict";
async function listBackupKeys(client, bucket, licenseId) {
  const { ListObjectsV2Command } = require("@aws-sdk/client-s3");
  const prefix = `${licenseId}/backups/`;
  const out = [];
  let token;
  do {
    const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents || []) {
      if (!o.Key.endsWith(".db.gz")) continue;
      const rest = o.Key.slice(prefix.length, -".db.gz".length);
      const slash = rest.lastIndexOf("/");
      out.push({ key: o.Key, machine_id: slash > 0 ? rest.slice(0, slash) : null, timestamp: slash > 0 ? rest.slice(slash + 1) : rest,
                 size: o.Size ?? null, lastModified: o.LastModified ? new Date(o.LastModified).toISOString() : null });
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return out;
}
module.exports = { listBackupKeys };
