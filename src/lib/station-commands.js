'use strict';
// src/lib/station-commands.js — which /api/cmd commands act on ONE station's machine, and how the
// backend stamps the target for them (web remote slice 1, 2026-09-16).
//
// THE LIST IS A MIRROR of the desktop's STATION_SCOPED set in
//   C:\openair\src\audio\cmd-routing.ts:24-40
// (the desktop's cmd-routing.ts is the source of truth; station-commands.test.js compares the two lists
// whenever the desktop repo is on the same disk — edit both). Everything NOT in this set is license-wide and is passed through untouched:
// db:apply (synced tables — every install must apply it), library:*, health:watch, jukebox:request.
//
// THE RULING (docs/web-remote-design-2026-09-16.md §0-§1): the web remote controls ONLY the machine
// sourcing the station's stream — station_now_playing.source_machine_id, the sticky column (the
// last machine that sourced it), never the 90s-gated view. The backend stamps target_machine_id from
// it and DISCARDS whatever the browser sent, so no page can aim a control at another machine. The one
// exception is the handoff's grab: `stream:start` on a station with NO fresh source may name a device
// (that is how the source changes — "move broadcast"), validated against this license's activations.
//
// Pure: no DB, no HTTP. The route does the three lookups and hands them in, so this is testable with
// node:test and nothing else (see station-commands.test.js).

const STATION_SCOPED = new Set([
  "skip", "automation_on", "automation_off", "stop_all", "play", "pause", "play_now",
  "set_volume", "play_emergency_cart", "mic_on",
  "deck:load", "deck:cue", "deck:crossfade", "deck:off",
  "queue:enqueue", "queue:reorder", "queue:remove", "queue:move", "queue:clear",
  "stream:start", "stream:stop",
  "stream:restart",   // the web's Restart = a stream restart on the target (web remote slice 4)
  "cart:fire",
  "ops:set-closing",
]);

function isStationScopedCommand(cmd) {
  return STATION_SCOPED.has(String(cmd || ""));
}

/**
 * Decide the target for one command.
 * @param {object} p
 * @param {string} p.cmd
 * @param {object} p.body           the request body (mutated copy is returned, never the original)
 * @param {boolean} p.stationOwned  station_uuid exists AND belongs to the caller's license
 * @param {object|null} p.nowPlaying  raw row: { source_machine_id, source_machine_id_at } or null
 * @param {(machineId:string)=>{machine_id:string,machine_name:string|null}|null} p.deviceLookup
 *        an activation on THIS license with deauthorized_at IS NULL, or null
 * @param {(id, at)=>string|null} p.resolveSourceMachineId  station-state.js (fresh-or-null)
 * @returns {{ok:true, body:object, target:{machine_id:string, machine_name:string|null}, via:string}
 *         | {ok:false, status:number, error:string, detail?:object}}
 */
function stampTarget({ cmd, body, stationOwned, nowPlaying, deviceLookup, resolveSourceMachineId }) {
  const out = { ...(body || {}) };
  if (!isStationScopedCommand(cmd)) return { ok: true, body: out, target: null, via: "license-wide" };

  const stationUuid = typeof out.station_uuid === "string" ? out.station_uuid.trim() : "";
  if (!stationUuid) return { ok: false, status: 400, error: "station_uuid_required", detail: { cmd } };
  if (!stationOwned)  return { ok: false, status: 400, error: "station_not_found", detail: { cmd, station_uuid: stationUuid } };

  const rawSource = nowPlaying && typeof nowPlaying.source_machine_id === "string" && nowPlaying.source_machine_id.trim()
    ? nowPlaying.source_machine_id.trim() : null;
  const freshSource = rawSource ? resolveSourceMachineId(rawSource, nowPlaying.source_machine_id_at) : null;

  // The handoff grab: stream:start with no FRESH source may name a device. The device must be one of
  // this license's live activations — a stale or foreign id is refused, never guessed at.
  const clientTarget = typeof out.target_machine_id === "string" ? out.target_machine_id.trim() : "";
  if (cmd === "stream:start" && !freshSource && clientTarget) {
    const dev = deviceLookup(clientTarget);
    if (!dev) return { ok: false, status: 400, error: "unknown_target_machine", detail: { cmd, target_machine_id: clientTarget } };
    out.target_machine_id = dev.machine_id;
    out.target_machine_name = dev.machine_name || null;
    return { ok: true, body: out, target: { machine_id: dev.machine_id, machine_name: dev.machine_name || null }, via: "handoff-grab" };
  }

  // Every other case: the sticky source (the last machine that sourced the stream) is the target,
  // whatever the browser sent.
  if (!rawSource) return { ok: false, status: 409, error: "no_source_machine", detail: { cmd, station_uuid: stationUuid } };
  const dev = deviceLookup(rawSource);
  out.target_machine_id = rawSource;
  out.target_machine_name = dev ? (dev.machine_name || null) : null;
  return { ok: true, body: out, target: { machine_id: rawSource, machine_name: out.target_machine_name }, via: freshSource ? "source" : "last-source" };
}

module.exports = { STATION_SCOPED, isStationScopedCommand, stampTarget };
