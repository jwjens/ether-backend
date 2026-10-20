const test = require("node:test");
const assert = require("node:assert");
const { listBackupKeys } = require("./backup-keys");

// A fake R2 that pages 2 keys at a time, mixing old account-wide keys and two computers' folders.
const KEYS = ["7/backups/2026-10-01T10-00-00.db.gz", "7/backups/2026-10-01T10-00-00.meta.json",
  "7/backups/aaaa1111-0000/2026-10-20T09-00-00.db.gz", "7/backups/aaaa1111-0000/2026-10-20T09-00-00.meta.json",
  "7/backups/bbbb2222-0000/2026-10-20T11-30-00.db.gz", "7/backups/aaaa1111-0000/2026-10-19T23-00-00.db.gz"];
const fake = { async send(cmd) {
  const start = Number(cmd.input.ContinuationToken || 0);
  const page = KEYS.slice(start, start + 2).map(Key => ({ Key, Size: 100 }));
  const next = start + 2;
  return { Contents: page, IsTruncated: next < KEYS.length, NextContinuationToken: String(next) };
} };

test("every page is read, only .db.gz, newest first by timestamp, with the computer that made it", async () => {
  const r = await listBackupKeys(fake, "b", 7);
  assert.deepStrictEqual(r.map(x => x.timestamp), ["2026-10-20T11-30-00", "2026-10-20T09-00-00", "2026-10-19T23-00-00", "2026-10-01T10-00-00"]);
  assert.deepStrictEqual(r.map(x => x.machine_id), ["bbbb2222-0000", "aaaa1111-0000", "aaaa1111-0000", null]);
});
