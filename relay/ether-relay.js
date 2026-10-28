'use strict';
// ETHER-RELAY — the Remote Link's UDP relay (docs/remote-link-relay-plan-2026-10-28.md, openair repo). Jeff approved option A
// (2026-10-28): it runs on the Lightsail stream server as its own user and service; Icecast is never touched.
//
// What it does: two Ether machines that cannot reach each other (routers, no port forwarding) both talk OUT to the relay;
// the relay forwards between them. It never sees audio — Link packets are sealed end to end before they arrive — and
// stores nothing. Who may use a session is proven by a TICKET the backend signs (relay/ticket.js); the relay checks it
// with the shared secret, no database.
//
// WIRE: every packet to the relay starts with "ER" (0x45 0x52), a type byte and the session's 8-byte tag:
//   0x01 HELLO     sender   → relay   + ticket (utf8)   the sender's address for this session (sent every 15 s)
//   0x02 REGISTER  receiver → relay   + ticket (utf8)   the receiver's address (every 15 s: keeps its router open)
//   0x10 TO_RX     sender   → relay   + Link packet     forwarded, header removed, to the registered receiver
//   0x11 TO_TX     receiver → relay   + Link packet     forwarded, header removed, to the registered sender
//   0x20 ACK       relay    → either  + status byte     0 = joined (other side present), 1 = bad/expired ticket,
//                                                       2 = joined, waiting for the other side
// A data packet is forwarded only if it comes FROM the address that presented a valid ticket for that session; anything
// else is dropped and counted. A session with no packets for 60 s is forgotten; an expired ticket ends it.
const dgram = require("dgram");
const { verifyTicket } = require("./ticket");

const MAGIC0 = 0x45, MAGIC1 = 0x52, HDR = 11;
const T = { HELLO: 0x01, REGISTER: 0x02, TO_RX: 0x10, TO_TX: 0x11, ACK: 0x20 };
const IDLE_MS = 60 * 1000;
const MAX_SESSIONS = 2000;
const MAX_PPS = 250;                  // per session and direction: a 20 ms Link is 50/s; this is headroom, not a quota

const addrKey = (r) => `${r.address}:${r.port}`;

function header(type, tagBuf) { const h = Buffer.alloc(HDR); h[0] = MAGIC0; h[1] = MAGIC1; h[2] = type; tagBuf.copy(h, 3, 0, 8); return h; }

function createRelay({ secret, port = 9790, host = "0.0.0.0", now = () => Date.now(), log = console.log } = {}) {
  if (!secret || String(secret).length < 32) throw new Error("ETHER_RELAY_SECRET must be at least 32 characters");
  const sock = dgram.createSocket("udp4");
  const sessions = new Map();   // tag hex → { sender, receiver, exp, last, rate: { tx: [sec, n], rx: [sec, n] }, n: {...} }
  const stats = { packets: 0, forwarded: 0, dropped: { bad_header: 0, bad_ticket: 0, unknown_session: 0, wrong_source: 0, no_peer: 0, rate: 0, full: 0 } };

  function ack(tag, status, to) { sock.send(Buffer.concat([header(T.ACK, tag), Buffer.from([status])]), to.port, to.address); }
  function rateOk(s, dir) {
    const sec = Math.floor(now() / 1000), r = s.rate[dir];
    if (r[0] !== sec) { r[0] = sec; r[1] = 0; }
    return ++r[1] <= MAX_PPS;
  }

  sock.on("message", (m, r) => {
    stats.packets++;
    if (m.length < HDR || m[0] !== MAGIC0 || m[1] !== MAGIC1) { stats.dropped.bad_header++; return; }
    const type = m[2], tagBuf = m.subarray(3, 11), tag = tagBuf.toString("hex");
    if (type === T.HELLO || type === T.REGISTER) {
      const t = verifyTicket(secret, m.subarray(HDR).toString("utf8"), now());
      if (!t || t.session !== tag) { stats.dropped.bad_ticket++; ack(tagBuf, 1, r); return; }
      let s = sessions.get(tag);
      if (!s) {
        if (sessions.size >= MAX_SESSIONS) { stats.dropped.full++; return; }
        s = { sender: null, receiver: null, exp: t.expiresAt, last: now(), rate: { tx: [0, 0], rx: [0, 0] } };
        sessions.set(tag, s);
      }
      s.exp = Math.max(s.exp, t.expiresAt); s.last = now();
      if (type === T.HELLO) s.sender = { address: r.address, port: r.port }; else s.receiver = { address: r.address, port: r.port };
      ack(tagBuf, s.sender && s.receiver ? 0 : 2, r);
      return;
    }
    if (type !== T.TO_RX && type !== T.TO_TX) { stats.dropped.bad_header++; return; }
    const s = sessions.get(tag);
    if (!s || s.exp <= now()) { stats.dropped.unknown_session++; return; }
    const from = type === T.TO_RX ? s.sender : s.receiver;
    const to = type === T.TO_RX ? s.receiver : s.sender;
    if (!from || addrKey(from) !== addrKey(r)) { stats.dropped.wrong_source++; return; }
    if (!to) { stats.dropped.no_peer++; return; }
    if (!rateOk(s, type === T.TO_RX ? "tx" : "rx")) { stats.dropped.rate++; return; }
    s.last = now();
    stats.forwarded++;
    sock.send(m.subarray(HDR), to.port, to.address);
  });

  const sweep = setInterval(() => {
    const t = now();
    for (const [k, s] of sessions) if (t - s.last > IDLE_MS || s.exp <= t) sessions.delete(k);
  }, 10 * 1000);
  sweep.unref?.();

  return {
    start: () => new Promise((resolve, reject) => { sock.once("error", reject); sock.bind(port, host, () => { sock.off("error", reject); log(`[ether-relay] listening on udp ${host}:${sock.address().port}`); resolve(sock.address().port); }); }),
    stop: () => new Promise((resolve) => { clearInterval(sweep); try { sock.close(resolve); } catch { resolve(); } }),
    sweepNow: () => { const t = now(); for (const [k, s] of sessions) if (t - s.last > IDLE_MS || s.exp <= t) sessions.delete(k); },
    snapshot: () => ({ sessions: sessions.size, ...stats, dropped: { ...stats.dropped } }),
  };
}

module.exports = { createRelay, T, HDR, header };

// ── run as a service ─────────────────────────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const relay = createRelay({ secret: process.env.ETHER_RELAY_SECRET, port: Number(process.env.ETHER_RELAY_PORT || 9790) });
  relay.start().catch((e) => { console.error("[ether-relay] could not start:", e.message); process.exit(1); });
  setInterval(() => console.log("[ether-relay]", JSON.stringify(relay.snapshot())), 60 * 1000).unref?.();
  const bye = () => relay.stop().then(() => process.exit(0));
  process.on("SIGTERM", bye); process.on("SIGINT", bye);
}
