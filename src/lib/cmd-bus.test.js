'use strict';
// Web remote slice 2 (backend) — the command bus knows WHICH MACHINE is on each SSE client, and a station control
// with a target is delivered ONLY to that machine. No matching client → NOT queued (a station control that lands
// minutes later on reconnect is worse than none), and /api/cmd answers 409 target_offline.
// Run:  node --test src/lib/cmd-bus.test.js
const test   = require("node:test");
const assert = require("node:assert");
const bus = require("./cmd-bus");

function fakeRes(machineId) {
  const out = [];
  return { machineId, writableEnded: false, write: (s) => out.push(s), out };
}
const sent = (res) => res.out.map(s => JSON.parse(s.split("data: ")[1]));

test("a client is registered with the machine id it connected with", () => {
  const clients = new Map();
  const a = fakeRes(); const b = fakeRes();
  bus.registerClient(clients, "7", a, " ov-machine ");
  bus.registerClient(clients, "7", b, "");
  assert.equal(a.machineId, "ov-machine");
  assert.equal(b.machineId, null);
  assert.equal(clients.get("7").size, 2);
  bus.unregisterClient(clients, "7", a); bus.unregisterClient(clients, "7", b);
  assert.equal(clients.has("7"), false);
});

test("a targeted command reaches ONLY the named machine", () => {
  const clients = new Map(), pending = new Map();
  const ov = fakeRes(), ev = fakeRes(), old = fakeRes();
  bus.registerClient(clients, "7", ov, "ov-machine");
  bus.registerClient(clients, "7", ev, "ovevents-machine");
  bus.registerClient(clients, "7", old, null);          // a pre-slice desktop: no id → never a target
  const r = bus.emitCommand({ sseClients: clients, pendingCmds: pending, licenseId: "7", cmd: "skip", stationScoped: true,
                              data: { station_uuid: "st-1", target_machine_id: "ov-machine" } });
  assert.equal(r.delivered, 1);
  assert.equal(r.target_connected, true);
  assert.equal(r.queued, false);
  assert.equal(sent(ov).length, 1);
  assert.equal(sent(ev).length, 0);
  assert.equal(sent(old).length, 0);
});

test("target not connected → delivered to nobody, NOT queued, target_connected:false", () => {
  const clients = new Map(), pending = new Map();
  const ev = fakeRes();
  bus.registerClient(clients, "7", ev, "ovevents-machine");
  const r = bus.emitCommand({ sseClients: clients, pendingCmds: pending, licenseId: "7", cmd: "stream:restart", stationScoped: true,
                              data: { station_uuid: "st-1", target_machine_id: "ov-machine" } });
  assert.deepEqual({ delivered: r.delivered, queued: r.queued, target_connected: r.target_connected }, { delivered: 0, queued: false, target_connected: false });
  assert.equal(sent(ev).length, 0);
  assert.equal(pending.has("7"), false);
  // nobody connected at all → still not queued
  const r2 = bus.emitCommand({ sseClients: new Map(), pendingCmds: pending, licenseId: "7", cmd: "skip", stationScoped: true,
                               data: { station_uuid: "st-1", target_machine_id: "ov-machine" } });
  assert.equal(r2.queued, false);
  assert.equal(pending.has("7"), false);
});

test("untargeted commands fan out and queue exactly as before", () => {
  const clients = new Map(), pending = new Map();
  const a = fakeRes("m1"), b = fakeRes(null);
  bus.registerClient(clients, "7", a, "m1"); bus.registerClient(clients, "7", b, null);
  const r = bus.emitCommand({ sseClients: clients, pendingCmds: pending, licenseId: "7", cmd: "db:apply", stationScoped: false, data: { table: "categories" } });
  assert.equal(r.delivered, 2);
  assert.equal(r.target_connected, null);
  const q = bus.emitCommand({ sseClients: new Map(), pendingCmds: pending, licenseId: "9", cmd: "jukebox:request", stationScoped: false, data: {} });
  assert.equal(q.queued, true);
  assert.equal(pending.get("9").length, 1);
});

test("the 409 names the machine and when it was last seen", () => {
  assert.deepEqual(bus.targetOffline({ machineId: "ov-machine", machineName: "ovowforestmusic", offlineSince: "2026-09-27T10:00:00Z" }),
    { status: 409, body: { error: "target_offline", machine: "ovowforestmusic", offline_since: "2026-09-27T10:00:00Z" } });
  assert.equal(bus.targetOffline({ machineId: "ov-machine", machineName: null, offlineSince: null }).body.machine, "ov-machine");
});

test("the routes are wired: cmd-stream registers ?machine_id, /api/cmd refuses target_offline", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "index.js"), "utf8");
  assert.match(src, /registerClient\(sseClients, licenseId, res, req\.query\.machine_id\)/);
  assert.match(src, /target_connected === false/);
  assert.match(src, /targetOffline\(/);
});

// ── SLICE 5 (backend): cmd_id on every station command; the target's ack is kept per license and read back. ──
test("every emitted STATION command carries a cmd_id; license-wide commands do not", () => {
  const clients = new Map(), pending = new Map();
  const ov = fakeRes();
  bus.registerClient(clients, "7", ov, "ov-machine");
  let n = 0; const newId = () => `cmd-${++n}`;
  const r = bus.emitCommand({ sseClients: clients, pendingCmds: pending, licenseId: "7", cmd: "skip", stationScoped: true, newId,
                              data: { station_uuid: "st-1", target_machine_id: "ov-machine" } });
  assert.equal(r.cmd_id, "cmd-1");
  assert.equal(sent(ov)[0].data.cmd_id, "cmd-1");         // the desktop reads data.cmd_id for its ack
  const d = bus.emitCommand({ sseClients: clients, pendingCmds: pending, licenseId: "7", cmd: "db:apply", stationScoped: false, newId, data: {} });
  assert.equal(d.cmd_id, null);
  assert.equal("cmd_id" in sent(ov)[1].data, false);
  const input = { station_uuid: "st-1", target_machine_id: "ov-machine" };
  bus.emitCommand({ sseClients: clients, pendingCmds: pending, licenseId: "7", cmd: "skip", stationScoped: true, newId, data: input });
  assert.equal("cmd_id" in input, false);                   // the caller's object is never mutated
});

test("acks: stored per license in a bounded ring, read back by cmd_id, newest wins", () => {
  const acks = new Map();
  const at = "2026-09-27T12:00:00.000Z";
  assert.deepEqual(bus.recordAck(acks, "7", { cmd_id: "c1", station_uuid: "st-1", machine_id: "ov", ok: false, error: "403 Forbidden" }, at),
    { ok: true, ack: { cmd_id: "c1", ok: false, error: "403 Forbidden", machine_id: "ov", station_uuid: "st-1", at } });
  assert.equal(bus.findAck(acks, "7", "c1").error, "403 Forbidden");
  assert.equal(bus.findAck(acks, "8", "c1"), null);                     // another license never sees it
  bus.recordAck(acks, "7", { cmd_id: "c1", machine_id: "ov", ok: true }, at);
  assert.equal(bus.findAck(acks, "7", "c1").ok, true);
  for (let i = 0; i < bus.ACK_RING + 10; i++) bus.recordAck(acks, "7", { cmd_id: `x${i}`, ok: true }, at);
  assert.equal(acks.get("7").length, bus.ACK_RING);
  assert.equal(bus.findAck(acks, "7", "x0"), null);                      // oldest fell off
});

test("an ack without a cmd_id, or with a non-boolean ok, is refused", () => {
  const acks = new Map();
  assert.deepEqual(bus.recordAck(acks, "7", { ok: true }, "t"), { ok: false, status: 400, error: "cmd_id_required" });
  assert.deepEqual(bus.recordAck(acks, "7", { cmd_id: "c", ok: "yes" }, "t"), { ok: false, status: 400, error: "ok_must_be_boolean" });
  assert.equal(acks.size, 0);
});

test("the routes are wired: /api/cmd returns the delivery facts; POST /api/cmd/ack (license) and GET /api/cmd/ack/:cmd_id (JWT)", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "index.js"), "utf8");
  assert.match(src, /res\.json\(\{ ok: true, cmd_id: sent\.cmd_id, delivered: sent\.delivered, target_machine_id: target \? target\.machine_id : null, target_machine_name: target \? \(target\.machine_name \|\| null\) : null, target_connected: sent\.target_connected \}\)/);
  assert.match(src, /app\.post\("\/api\/cmd\/ack",/);
  assert.match(src, /app\.get\("\/api\/cmd\/ack\/:cmd_id", requireAuth,/);
});
