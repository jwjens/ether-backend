// src/lib/pin-hash.js — a copy of the desktop's electron/pin-hash.js (openair). Keep the two identical: a PIN hashed on
// either side must verify on the other (install-pushed users, /api/account/users/sync).
// electron/pin-hash.js — USER PINs ARE STORED WITH A SLOW HASH (Jeff, 2026-10-20: "switch PINs to a slow hash first, then
// add users to sync"). docs/ovevents-categories-and-users-sync-2026-10-20.md.
//
// A 4–6 digit PIN under salt:sha256 can be recovered from its hash in well under a second by trying every PIN. That
// hash already leaves the computer (src/lib/syncUsers.ts → the backend, for the dashboard login) and will travel with
// users sync. scrypt makes each guess cost real memory and time.
//
// Formats understood (verify): scrypt$<N>$<r>$<p>$<salt hex>$<hash hex>  (new)
//                              <salt hex>:<sha256 hex>                   (before 4.6.62)
//                              <the PIN itself>                          (very old installs, and a fallback that saved it)
// Only scrypt is written. verify() says when a stored value should be upgraded (needsUpgrade) — the caller re-hashes it
// with the PIN it just checked. The work runs on libuv's thread pool (async crypto.scrypt): the main thread never waits.
// The cost parameters are security settings, not on-air behaviour; the backend uses the same function shape.
"use strict";
const crypto = require("crypto");

const N = 1 << 15, R = 8, P = 1, KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

function _scrypt(pin, salt, n, r, p) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(String(pin), Buffer.from(salt, "hex"), KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (e, k) => e ? reject(e) : resolve(k)));
}

async function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await _scrypt(pin, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt}$${key.toString("hex")}`;
}

const isScrypt = (stored) => typeof stored === "string" && stored.startsWith("scrypt$");
const isSaltedSha256 = (stored) => typeof stored === "string" && /^[0-9a-f]{32}:[0-9a-f]{64}$/i.test(stored);
const isPlain = (stored) => typeof stored === "string" && stored.length > 0 && !isScrypt(stored) && !isSaltedSha256(stored);

function _eq(a, b) {
  const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** → { ok, needsUpgrade } */
async function verifyPin(pin, stored) {
  if (!stored || pin == null) return { ok: false, needsUpgrade: false };
  if (isScrypt(stored)) {
    const [, n, r, p, salt, hash] = stored.split("$");
    try { const k = await _scrypt(pin, salt, Number(n), Number(r), Number(p)); return { ok: _eq(k.toString("hex"), hash), needsUpgrade: false }; }
    catch { return { ok: false, needsUpgrade: false }; }
  }
  if (isSaltedSha256(stored)) {
    const [salt, hash] = stored.split(":");
    const ok = _eq(crypto.createHash("sha256").update(salt + pin).digest("hex"), hash);
    return { ok, needsUpgrade: ok };
  }
  // A stored PIN in the clear: compared in constant time; always upgraded.
  const a = Buffer.from(String(pin)), b = Buffer.from(String(stored));
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, needsUpgrade: ok };
}

module.exports = { hashPin, verifyPin, isScrypt, isSaltedSha256, isPlain, PARAMS: { N, R, P, KEYLEN } };
