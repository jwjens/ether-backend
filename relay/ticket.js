'use strict';
// REMOTE LINK RELAY TICKETS (docs/remote-link-relay-plan-2026-10-28.md, openair repo). Shared by the backend (which signs
// them) and the relay (which checks them): one format, one file, no database on the relay.
//
// A ticket = base64url(JSON { s: session id (16 hex = 8 bytes), snd: sending machine id, rcv: receiving machine id,
// exp: expiry (unix seconds) }) + "." + base64url(HMAC-SHA256(secret, that first part)). The relay accepts a ticket only
// with a valid signature and an unexpired exp, and then forwards ONLY between the one sender address and the one
// receiver address that presented it. It never sees audio: Link packets are sealed end to end (ChaCha20-Poly1305 bound to
// both machine ids) before they reach it.
const crypto = require("crypto");

const b64 = (b) => Buffer.from(b).toString("base64url");
const mac = (secret, body) => crypto.createHmac("sha256", String(secret)).update(body).digest();

/** Sign a ticket. `sessionHex` is 16 hex chars (the 8-byte tag every relayed packet carries). */
function signTicket(secret, { sessionHex, sender, receiver, expiresAt }) {
  if (!/^[0-9a-f]{16}$/.test(sessionHex)) throw new Error("session must be 16 hex");
  const body = b64(JSON.stringify({ s: sessionHex, snd: String(sender), rcv: String(receiver), exp: Math.floor(expiresAt / 1000) }));
  return `${body}.${b64(mac(secret, body))}`;
}

/** Check a ticket. → { session, sender, receiver, expiresAt } or null (bad shape, bad signature, expired). */
function verifyTicket(secret, ticket, now = Date.now()) {
  const t = String(ticket || "");
  const dot = t.indexOf(".");
  if (dot < 1 || t.length > 600) return null;
  const body = t.slice(0, dot), sig = Buffer.from(t.slice(dot + 1), "base64url");
  const want = mac(secret, body);
  if (sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) return null;
  let j;
  try { j = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!j || !/^[0-9a-f]{16}$/.test(j.s) || !j.snd || !j.rcv || !Number.isFinite(j.exp)) return null;
  if (j.exp * 1000 <= now) return null;
  return { session: j.s, sender: j.snd, receiver: j.rcv, expiresAt: j.exp * 1000 };
}

module.exports = { signTicket, verifyTicket };
