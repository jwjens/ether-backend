'use strict';
// src/lib/cmd-bus.js — command delivery for the desktop command bus (web remote, docs/web-remote-design-2026-09-16.md).
//
// SLICE 2 (backend): every SSE client carries the machine id it connected with (/api/cmd-stream?machine_id=).
// A command whose data carries target_machine_id is written ONLY to the client(s) of that machine. No such client
// → it is NOT queued: a station control that lands minutes later, on reconnect, is worse than none — the caller
// answers 409 target_offline instead. Commands with no target (db:apply, library:*, health:watch,
// jukebox:request) fan out to every client and queue when nobody listens, exactly as before.
//
// Pure apart from the res objects it writes to: no DB, no HTTP — tested with fake clients (cmd-bus.test.js).

const PENDING_MAX = 20;

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
 * @returns {{ delivered:number, queued:boolean, target_connected:boolean|null, data:object }}
 *   target_connected is null for an untargeted command.
 */
function emitCommand({ sseClients, pendingCmds, licenseId, cmd, data }) {
  const lid = String(licenseId);
  const body = data || {};
  const ts = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ cmd, data: body, ts });
  const clients = [...(sseClients.get(lid) || [])].filter(c => !c.writableEnded);
  const target = typeof body.target_machine_id === "string" ? body.target_machine_id.trim() : "";

  if (target) {
    const to = clients.filter(c => c.machineId === target);
    for (const c of to) c.write(`event: cmd\ndata: ${payload}\n\n`);
    console.log(`[cmd] ${cmd} -> ${to.length ? `delivered to ${target}` : `target ${target} NOT CONNECTED — not sent, not queued`} license=${lid}`);
    return { delivered: to.length, queued: false, target_connected: to.length > 0, data: body };
  }

  if (clients.length > 0) {
    for (const c of clients) c.write(`event: cmd\ndata: ${payload}\n\n`);
    console.log(`[cmd] ${cmd} -> SSE fan-out to ${clients.length} client(s) for license=${lid}`);
    return { delivered: clients.length, queued: false, target_connected: null, data: body };
  }
  // Nobody listening: queue it. A guest at an event must not lose their request because the desktop happened to
  // reconnect a second earlier.
  const q = pendingCmds.get(lid) || [];
  q.push({ cmd, data: body, ts });
  if (q.length > PENDING_MAX) q.splice(0, q.length - PENDING_MAX);
  pendingCmds.set(lid, q);
  console.log(`[cmd] ${cmd} -> queued for license=${lid} (no listener)`);
  return { delivered: 0, queued: true, target_connected: null, data: body };
}

/** The refusal /api/cmd (and the Park Ops routes) give when the target machine is not connected. */
function targetOffline({ machineId, machineName, offlineSince }) {
  return { status: 409, body: { error: "target_offline", machine: machineName || machineId || null, offline_since: offlineSince || null } };
}

module.exports = { registerClient, unregisterClient, emitCommand, targetOffline, PENDING_MAX };
