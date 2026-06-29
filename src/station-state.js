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

module.exports = { deriveStationState, HEARTBEAT_STALE_MS };
