'use strict';
// src/lib/park-auth.js — staff log in to the Park page with the account's EXISTING username + PIN users
// (Jeff, 2026-10-13: "Reuse it, don't build a second one").
//
// The users are account_users: the people created in Ether → Settings → Users & Security (mirrored up) or on the
// Remote page, each with a username and a 4-digit PIN in the shared "salt:sha256" form. The Park page adds only:
//   · WHO MAY use a station's Park page — park_access (account, username, station), granted on the Remote page's
//     Users tab;
//   · A DEVICE SESSION — a random token the page keeps, stored here only as its sha256. It stays good until Log out,
//     until that user's PIN changes, until the user is removed, or until their Park access for that station is taken
//     away. All four are checked on EVERY request (sessionVerdict), so a change logs the device out at once;
//   · THE SAME LOCKOUT the Remote page login uses (account_users.failed_attempts / locked_until), its two numbers
//     now visible settings per account (lockoutRule) instead of constants in code.
//
// Pure: no DB, no clock of its own — index.js does the lookups. Every branch is pinned by park-auth.test.js.
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** A new device session: the token the page keeps, and the hash this server stores. */
function newSession() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenHash: sha256(token) };
}
const tokenHash = (token) => sha256(token);
/** A fingerprint of the user's stored PIN: when the PIN changes, the fingerprint changes, and every session made under
 *  the old PIN is refused. (The PIN itself is never stored here.) */
const pinFingerprint = (pinHash) => sha256('park-pin:' + String(pinHash || ''));

/**
 * Is this device session still good?
 * @param {{ended_at:any, pin_fp:string, station_uuid:string}|null} session
 * @param {{pin_hash:string}|null} user       the live account_users row for that username (null = removed)
 * @param {boolean} hasAccess                  park_access row exists for this user + station
 * @param {string} stationUuid                 the station the request is for
 * @returns {{ok:true}|{ok:false, reason:string, message:string}}
 */
function sessionVerdict(session, user, hasAccess, stationUuid) {
  if (!session) return { ok: false, reason: 'no_session', message: 'Please log in.' };
  if (session.ended_at) return { ok: false, reason: 'logged_out', message: 'You were logged out. Please log in again.' };
  if (session.station_uuid !== stationUuid) return { ok: false, reason: 'other_station', message: 'This login is for a different station. Please log in here.' };
  if (!user) return { ok: false, reason: 'user_removed', message: 'This user was removed. Ask the station manager.' };
  if (pinFingerprint(user.pin_hash) !== session.pin_fp) return { ok: false, reason: 'pin_changed', message: 'Your PIN was changed. Please log in with the new PIN.' };
  if (!hasAccess) return { ok: false, reason: 'no_access', message: 'You are no longer allowed on this Park page. Ask the station manager.' };
  return { ok: true };
}

/** The account's lockout settings, with the values that applied before they were settings (5 tries, 15 minutes). */
const LOCKOUT_START = { maxFails: 5, lockoutMinutes: 15 };
function lockoutRule(row) {
  const f = Number(row ? row.pin_max_fails : NaN), m = Number(row ? row.pin_lockout_minutes : NaN);
  return {
    maxFails: Number.isInteger(f) && f >= 1 ? f : LOCKOUT_START.maxFails,
    lockoutMinutes: Number.isFinite(m) && m >= 1 ? m : LOCKOUT_START.lockoutMinutes,
  };
}
/** After a WRONG PIN: the new counter and, when the limit is reached, when the lock ends. */
function afterWrongPin(failedAttempts, rule, now) {
  const fails = (Number(failedAttempts) || 0) + 1;
  if (fails >= rule.maxFails) return { failed_attempts: 0, locked_until: new Date(now + rule.lockoutMinutes * 60 * 1000) };
  return { failed_attempts: fails, locked_until: null };
}
function validSettings(body) {
  const maxFails = Number(body && body.pin_max_fails), lockoutMinutes = Number(body && body.pin_lockout_minutes);
  if (!Number.isInteger(maxFails) || maxFails < 1 || maxFails > 20) return { ok: false, error: 'Wrong-PIN tries must be a whole number from 1 to 20.' };
  if (!Number.isInteger(lockoutMinutes) || lockoutMinutes < 1 || lockoutMinutes > 1440) return { ok: false, error: 'Lock-out time must be a whole number of minutes from 1 to 1440.' };
  return { ok: true, maxFails, lockoutMinutes };
}

module.exports = { newSession, tokenHash, pinFingerprint, sessionVerdict, lockoutRule, afterWrongPin, validSettings, LOCKOUT_START };
