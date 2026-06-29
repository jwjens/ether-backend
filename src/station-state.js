"use strict";
// Honest station state for operator/listener reporting (Slice 1 truth layer). Extracted so it can be
// unit-tested independently of the server (it gates "never a false LIVE", so it must be provable).
//
// HEARTBEAT freshness — not whether `playing` flipped — decides offline; engine_state decides live vs
// stalled vs off. It NEVER returns "live" for a stalled or idle engine. Legacy installs that don't
// send engine_state fall back to the prior playing+fresh heuristic (the caller COALESCEs heartbeatAt
// to updated_at, and the backend stamps engine_heartbeat_at=NOW() on every report, so freshness works
// even for a station that has stalled and is only sending keepalives).
const HEARTBEAT_STALE_MS = 90 * 1000; // ~4 missed 20s keepalives → offline (rides out transient network)

function deriveStationState(engineState, heartbeatAt, playing) {
  const beat = heartbeatAt ? new Date(heartbeatAt).getTime() : 0;
  const fresh = beat > 0 && (Date.now() - beat) < HEARTBEAT_STALE_MS;
  if (!fresh) return "offline";                  // heartbeat stale → the install isn't reporting
  if (engineState === "live") return "live";
  if (engineState === "stalled") return "stalled";
  if (engineState === "off") return "off";
  return playing ? "live" : "off";               // legacy install (no engine_state): playing+fresh = live
}

// Slice 2 — source-machine attribution + last error for the operator panel. Validates the desktop's
// now-playing fields before they hit the row, so the backend knows WHICH machine is sourcing each
// mount and the last stream error per station.
//   source_machine_id — the machine sourcing the mount. The desktop sends its OWN machine_id only
//                        while it is the live source (only one machine sources a mount at a time), so
//                        the stored value reflects the machine whose stream is actually live.
//   last_error/_at     — the most recent stream error for the station (e.g. an Icecast 403) + when it
//                        happened (client clock, ISO). Nullable: a clean report stores null, and the
//                        upsert keeps the prior error via COALESCE so a real last_error is never erased.
function parseSourceFields(body) {
  const b = body || {};
  const str = (v, max) => (typeof v === "string" && v.trim()) ? v.trim().slice(0, max) : null;
  const source_machine_id = str(b.source_machine_id, 128);
  const last_error = str(b.last_error, 500);
  let last_error_at = null;
  if (last_error && b.last_error_at != null) {            // a timestamp is only meaningful with an error
    const d = new Date(b.last_error_at);
    if (!isNaN(d.getTime())) last_error_at = d.toISOString();
  }
  return { source_machine_id, last_error, last_error_at };
}

// Slice 2 — release a stale source claim. source_machine_id is sticky in the row (a non-live machine's
// null report must NOT erase the real source, so the upsert COALESCEs it), but a source that genuinely
// went away has to be released — otherwise the panel sticks on a dead machine. The upsert stamps
// source_machine_id_at = NOW() ONLY when a live source affirms its id; this gates the EXPOSED value on
// that stamp's freshness. Crucially it uses the source's OWN heartbeat, not the row's engine_heartbeat_at
// (which another healthy non-sourcing machine could keep fresh with null reports → stuck claim).
function resolveSourceMachineId(sourceMachineId, sourceMachineIdAt) {
  if (!sourceMachineId) return null;
  const t = sourceMachineIdAt ? new Date(sourceMachineIdAt).getTime() : 0;
  if (!(t > 0) || (Date.now() - t) >= HEARTBEAT_STALE_MS) return null; // source stopped affirming → claim released
  return sourceMachineId;
}

module.exports = { deriveStationState, HEARTBEAT_STALE_MS, parseSourceFields, resolveSourceMachineId };
