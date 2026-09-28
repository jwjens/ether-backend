'use strict';
// src/lib/cmd-bus.js — command delivery for the desktop command bus (web remote, docs/web-remote-design-2026-09-16.md).
//
// SLICE 2 (backend): every SSE client carries the machine id it connected with (/api/cmd-stream?machine_id=).
// A command whose data carries target_machine_id is written ONLY to the client(s) of that machine. No such client
// → it is NOT queued: a station control that lands minutes later, on reconnect, is worse than none — the caller
// answers 409 target_offline instead. Commands with no target (db:apply, library:*, health:watch,
// jukebox:request) fan out to every client and queue when nobody listens, exactly as before.
//
// SLICE 5 (backend): every emitted STATION command carries a cmd_id (on data, where the desktop reads it), and the
// target's answer — POST /api/cmd/ack — is kept per license in a bounded ring so the page can read back what
// really happened (GET /api/cmd/ack/:cmd_id). In memory, like pendingCmds: an ack only matters for seconds.
//
// Pure apart from the res objects it writes to: no DB, no HTTP — tested with fake clients (cmd-bus.test.js).

const crypto = require("crypto");
const PENDING_MAX = 20;
const ACK_RING = 200;

function registerClient(sseClients, licenseId, res, machineId) {
  const lid = String(licenseId);
  const m = typeof machineId === "string" ? machineId.trim() : "";
  res.machineId = m || null;
  if (!sseClients.has(lid)) sseClients.set(lid, new Set());
  sseClients.get(lid).add(res);
  return sseClients.get(lid);
}

function unregisterClient(sseClients, licenseId, res) {
  const lid = String(licenseId);
  const set = sseClients.get(lid);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) sseClients.delete(lid);
}

/**
 * @returns {{ cmd_id:string|null, delivered:number, queued:boolean, target_connected:boolean|null, data:object }}
 *   target_connected is null for an untargeted command; cmd_id is null for a license-wide one.
 */
function emitCommand({ sseClients, pendingCmds, licenseId, cmd, data, stationScoped = false, newId = () => crypto.randomUUID() }) {
  const lid = String(licenseId);
  const body = stationScoped ? { ...(data || {}), cmd_id: (data && data.cmd_id) || newId() } : (data || {});
  const cmd_id = stationScoped ? body.cmd_id : null;
  const ts = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ cmd, data: body, ts });
  const clients = [...(sseClients.get(lid) || [])].filter(c => !c.writableEnded);
  const target = typeof body.target_machine_id === "string" ? body.target_machine_id.trim() : "";

  if (target) {
    const to = clients.filter(c => c.machineId === target);
    for (const c of to) c.write(`event: cmd\ndata: ${payload}\n\n`);
    console.log(`[cmd] ${cmd} -> ${to.length ? `delivered to ${target}` : `target ${target} NOT CONNECTED — not sent, not queued`} license=${lid}`);
    return { cmd_id, delivered: to.length, queued: false, target_connected: to.length > 0, data: body };
  }

  if (clients.length > 0) {
    for (const c of clients) c.write(`event: cmd\ndata: ${payload}\n\n`);
    console.log(`[cmd] ${cmd} -> SSE fan-out to ${clients.length} client(s) for license=${lid}`);
    return { cmd_id, delivered: clients.length, queued: false, target_connected: null, data: body };
  }
  // Nobody listening: queue it. A guest at an event must not lose their request because the desktop happened to
  // reconnect a second earlier.
  const q = pendingCmds.get(lid) || [];
  q.push({ cmd, data: body, ts });
  if (q.length > PENDING_MAX) q.splice(0, q.length - PENDING_MAX);
  pendingCmds.set(lid, q);
  console.log(`[cmd] ${cmd} -> queued for license=${lid} (no listener)`);
  return { cmd_id, delivered: 0, queued: true, target_connected: null, data: body };
}

/** Keep the target's answer for one command. Newest ack for a cmd_id wins; the ring keeps the last ACK_RING. */
function recordAck(acks, licenseId, body, at = new Date().toISOString()) {
  const b = body || {};
  const cmdId = typeof b.cmd_id === "string" ? b.cmd_id.trim() : "";
  if (!cmdId) return { ok: false, status: 400, error: "cmd_id_required" };
  if (typeof b.ok !== "boolean") return { ok: false, status: 400, error: "ok_must_be_boolean" };
  const ack = {
    cmd_id: cmdId, ok: b.ok,
    error: b.ok ? null : (b.error != null ? String(b.error).slice(0, 500) : null),
    machine_id: b.machine_id != null ? String(b.machine_id) : null,
    station_uuid: b.station_uuid != null ? String(b.station_uuid) : null,
    at,
  };
  const lid = String(licenseId);
  const ring = (acks.get(lid) || []).filter(a => a.cmd_id !== cmdId);
  ring.push(ack);
  if (ring.length > ACK_RING) ring.splice(0, ring.length - ACK_RING);
  acks.set(lid, ring);
  return { ok: true, ack };
}

function findAck(acks, licenseId, cmdId) {
  const ring = acks.get(String(licenseId)) || [];
  return ring.find(a => a.cmd_id === String(cmdId)) || null;
}

/** The refusal /api/cmd (and the Park Ops routes) give when the target machine is not connected. */
function targetOffline({ machineId, machineName, offlineSince }) {
  return { status: 409, body: { error: "target_offline", machine: machineName || machineId || null, offline_since: offlineSince || null } };
}

module.exports = { registerClient, unregisterClient, emitCommand, targetOffline, recordAck, findAck, PENDING_MAX, ACK_RING };
