'use strict';
// The Remote Link relay (relay/ether-relay.js) on a real UDP port: tickets, forwarding both ways, and every refusal.
const test = require("node:test");
const assert = require("node:assert");
const dgram = require("dgram");
const { createRelay, T, header } = require("./ether-relay");
const { signTicket, verifyTicket } = require("./ticket");

const SECRET = "x".repeat(40);
const TAG = "0011223344556677", TAGB = Buffer.from(TAG, "hex");
const ticket = (o = {}) => signTicket(o.secret || SECRET, { sessionHex: o.tag || TAG, sender: "m-venue", receiver: "m-ov", expiresAt: o.exp || Date.now() + 3600000 });

function peer() {
  const s = dgram.createSocket("udp4"); const inbox = [];
  s.on("message", (m) => inbox.push(m));
  return { s, inbox, ready: new Promise(r => s.bind(0, "127.0.0.1", r)),
           send: (buf, port) => new Promise(r => s.send(buf, port, "127.0.0.1", r)),
           close: () => new Promise(r => s.close(r)) };
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const pkt = (type, tag, body) => Buffer.concat([header(type, Buffer.from(tag, "hex")), Buffer.from(body)]);

async function rig() {
  const relay = createRelay({ secret: SECRET, port: 0, host: "127.0.0.1", log: () => {} });
  const port = await relay.start();
  const tx = peer(), rx = peer(), stranger = peer();
  await Promise.all([tx.ready, rx.ready, stranger.ready]);
  return { relay, port, tx, rx, stranger, close: async () => { await relay.stop(); await Promise.all([tx.close(), rx.close(), stranger.close()]); } };
}

test("tickets: signed, checked, expiring; a forged or altered one fails", () => {
  const t = ticket();
  assert.deepEqual(verifyTicket(SECRET, t), { session: TAG, sender: "m-venue", receiver: "m-ov", expiresAt: Math.floor((Date.now() + 3600000) / 1000) * 1000 });
  assert.equal(verifyTicket("y".repeat(40), t), null, "another secret");
  assert.equal(verifyTicket(SECRET, t.replace(/^./, c => (c === "A" ? "B" : "A"))), null, "altered");
  assert.equal(verifyTicket(SECRET, ticket({ exp: Date.now() - 1000 })), null, "expired");
});

test("the relay forwards both ways between the two ticket holders, header removed", async () => {
  const x = await rig();
  try {
    await x.tx.send(pkt(T.HELLO, TAG, ticket()), x.port);
    await x.rx.send(pkt(T.REGISTER, TAG, ticket()), x.port);
    await wait(100);
    assert.equal(x.rx.inbox.at(-1)[11], 0, "the receiver is told both sides are there");
    await x.tx.send(pkt(T.TO_RX, TAG, "sealed-audio-1"), x.port);
    await x.rx.send(pkt(T.TO_TX, TAG, "pong-1"), x.port);
    await wait(100);
    assert.equal(x.rx.inbox.map(String).includes("sealed-audio-1"), true);
    assert.equal(x.tx.inbox.map(String).includes("pong-1"), true);
    assert.equal(x.relay.snapshot().forwarded, 2);
  } finally { await x.close(); }
});

test("STRANGER: no ticket, a forged ticket, or data from an address that showed no ticket is dropped, never forwarded", async () => {
  const x = await rig();
  try {
    await x.tx.send(pkt(T.HELLO, TAG, ticket()), x.port);
    await x.rx.send(pkt(T.REGISTER, TAG, ticket()), x.port);
    await wait(80);
    const before = x.rx.inbox.length;
    await x.stranger.send(pkt(T.TO_RX, TAG, "injected"), x.port);                          // knows the tag, no ticket
    await x.stranger.send(pkt(T.HELLO, TAG, ticket({ secret: "z".repeat(40) })), x.port);  // a forged ticket
    await x.stranger.send(pkt(T.TO_RX, "ffffffffffffffff", "unknown session"), x.port);
    await x.stranger.send(Buffer.from("not a relay packet at all"), x.port);
    await wait(100);
    assert.equal(x.rx.inbox.length, before, "nothing reached the receiver");
    const d = x.relay.snapshot().dropped;
    assert.deepEqual([d.wrong_source, d.bad_ticket, d.unknown_session, d.bad_header], [1, 1, 1, 1]);
    assert.equal(x.stranger.inbox.at(-1)[11], 1, "the forged ticket is answered 'bad ticket'");
  } finally { await x.close(); }
});

test("a ticket for one session cannot open another (the tag must match the ticket)", async () => {
  const x = await rig();
  try {
    await x.stranger.send(pkt(T.HELLO, "aaaaaaaaaaaaaaaa", ticket()), x.port);
    await wait(80);
    assert.equal(x.relay.snapshot().dropped.bad_ticket, 1);
    assert.equal(x.relay.snapshot().sessions, 0);
  } finally { await x.close(); }
});

test("an idle session is forgotten; an expired ticket opens nothing", async () => {
  let t = Date.now();
  const relay = createRelay({ secret: SECRET, port: 0, host: "127.0.0.1", log: () => {}, now: () => t });
  const port = await relay.start();
  const a = peer(); await a.ready;
  try {
    await a.send(pkt(T.HELLO, TAG, ticket()), port); await wait(80);
    assert.equal(relay.snapshot().sessions, 1);
    t += 61 * 1000; relay.sweepNow();
    assert.equal(relay.snapshot().sessions, 0, "60 s without a packet");
    await a.send(pkt(T.HELLO, TAG, ticket({ exp: Date.now() - 1000 })), port); await wait(80);
    assert.equal(relay.snapshot().sessions, 0);
  } finally { await relay.stop(); await a.close(); }
});

test("it refuses to start without a long secret", () => {
  assert.throws(() => createRelay({ secret: "short" }), /at least 32/);
});
