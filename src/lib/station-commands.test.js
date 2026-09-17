'use strict';
// Web remote slice 1 — the backend stamps a station control's target from the sticky source machine.
// Pure decision (station-commands.js); the route's three lookups are handed in as values.
// Run:  node --test src/lib/station-commands.test.js
const test   = require("node:test");
const assert = require("node:assert");
const { STATION_SCOPED, isStationScopedCommand, stampTarget } = require("./station-commands");
const { resolveSourceMachineId, HEARTBEAT_STALE_MS } = require("../station-state");

const OV = { machine_id: "ov-machine", machine_name: "ovowforestmusic" };
const EV = { machine_id: "ovevents-machine", machine_name: "OVEVENTS" };
const devices = new Map([[OV.machine_id, OV], [EV.machine_id, EV]]);
const lookup = (id) => devices.get(id) || null;
const fresh = () => new Date().toISOString();
const stale = () => new Date(Date.now() - HEARTBEAT_STALE_MS - 1000).toISOString();
const decide = (cmd, body, np, owned = true) =>
  stampTarget({ cmd, body, stationOwned: owned, nowPlaying: np, deviceLookup: lookup, resolveSourceMachineId });

test("the list mirrors the desktop's STATION_SCOPED (cmd-routing.ts:24-40)", () => {
  const expected = [
    "skip", "automation_on", "automation_off", "stop_all", "play", "pause", "play_now",
    "set_volume", "play_emergency_cart", "mic_on",
    "deck:load", "deck:cue", "deck:crossfade", "deck:off",
    "queue:enqueue", "queue:reorder", "queue:remove", "queue:move", "queue:clear",
    "stream:start", "stream:stop", "cart:fire", "ops:set-closing",
  ];
  assert.deepEqual([...STATION_SCOPED].sort(), expected.sort());
  for (const c of expected) assert.equal(isStationScopedCommand(c), true, c);
});

test("stamping OVERWRITES a client-supplied target with the sticky source", () => {
  // The browser at OVEVENTS says "target me"; the station is sourced by OV → OV is the target.
  const r = decide("automation_off", { cmd: "automation_off", station_uuid: "st-1", target_machine_id: EV.machine_id },
                   { source_machine_id: OV.machine_id, source_machine_id_at: fresh() });
  assert.equal(r.ok, true);
  assert.equal(r.body.target_machine_id, OV.machine_id);
  assert.equal(r.body.target_machine_name, "ovowforestmusic");
  assert.equal(r.via, "source");
});

test("stream down: the LAST sourcer is still the target (sticky column, not the 90s view)", () => {
  const r = decide("stream:stop", { cmd: "stream:stop", station_uuid: "st-1" },
                   { source_machine_id: OV.machine_id, source_machine_id_at: stale() });
  assert.equal(r.ok, true);
  assert.equal(r.body.target_machine_id, OV.machine_id);
  assert.equal(r.via, "last-source");
});

test("no source machine EVER → 409 no_source_machine (the route does not emit/queue on !ok)", () => {
  for (const np of [null, { source_machine_id: null, source_machine_id_at: null }, { source_machine_id: "  ", source_machine_id_at: null }]) {
    const r = decide("stop_all", { cmd: "stop_all", station_uuid: "st-1" }, np);
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.equal(r.error, "no_source_machine");
  }
});

test("station_uuid required, and it must be the caller's station", () => {
  let r = decide("skip", { cmd: "skip" }, { source_machine_id: OV.machine_id, source_machine_id_at: fresh() });
  assert.deepEqual([r.ok, r.status, r.error], [false, 400, "station_uuid_required"]);
  r = decide("skip", { cmd: "skip", station_uuid: "st-x" }, { source_machine_id: OV.machine_id, source_machine_id_at: fresh() }, /* owned */ false);
  assert.deepEqual([r.ok, r.status, r.error], [false, 400, "station_not_found"]);
});

test("handoff grab: stream:start with NO fresh source keeps the client's target when it is a live device", () => {
  // stale source → the grab may name OVEVENTS
  let r = decide("stream:start", { cmd: "stream:start", station_uuid: "st-1", target_machine_id: EV.machine_id },
                 { source_machine_id: OV.machine_id, source_machine_id_at: stale() });
  assert.equal(r.ok, true);
  assert.equal(r.body.target_machine_id, EV.machine_id);
  assert.equal(r.body.target_machine_name, "OVEVENTS");
  assert.equal(r.via, "handoff-grab");
  // never sourced → same
  r = decide("stream:start", { cmd: "stream:start", station_uuid: "st-1", target_machine_id: EV.machine_id }, null);
  assert.equal(r.ok, true);
  assert.equal(r.via, "handoff-grab");
});

test("handoff grab refused with an unknown / deauthorized device → 400 unknown_target_machine", () => {
  const r = decide("stream:start", { cmd: "stream:start", station_uuid: "st-1", target_machine_id: "some-laptop" },
                   { source_machine_id: OV.machine_id, source_machine_id_at: stale() });
  assert.deepEqual([r.ok, r.status, r.error], [false, 400, "unknown_target_machine"]);
});

test("stream:start with a FRESH source ignores the client's target — the source is the target", () => {
  const r = decide("stream:start", { cmd: "stream:start", station_uuid: "st-1", target_machine_id: EV.machine_id },
                   { source_machine_id: OV.machine_id, source_machine_id_at: fresh() });
  assert.equal(r.ok, true);
  assert.equal(r.body.target_machine_id, OV.machine_id);
  assert.equal(r.via, "source");
});

test("stream:start with no fresh source and NO client target falls back to the last sourcer (a plain GO ON AIR)", () => {
  const r = decide("stream:start", { cmd: "stream:start", station_uuid: "st-1" },
                   { source_machine_id: OV.machine_id, source_machine_id_at: stale() });
  assert.equal(r.ok, true);
  assert.equal(r.body.target_machine_id, OV.machine_id);
  assert.equal(r.via, "last-source");
});

test("non-station commands are untouched and never refused", () => {
  for (const cmd of ["db:apply", "library:addSong", "library:syncDownload", "health:watch", "jukebox:request", "something:new"]) {
    const body = { cmd, station_uuid: "st-1", target_machine_id: "whatever", table: "clocks" };
    const r = decide(cmd, body, null, /* owned */ false);
    assert.equal(r.ok, true, cmd);
    assert.equal(r.via, "license-wide");
    assert.deepEqual(r.body, body);          // byte-for-byte pass-through
    assert.equal(isStationScopedCommand(cmd), false);
  }
});

test("the request body is never mutated in place", () => {
  const body = { cmd: "skip", station_uuid: "st-1", target_machine_id: EV.machine_id };
  decide("skip", body, { source_machine_id: OV.machine_id, source_machine_id_at: fresh() });
  assert.equal(body.target_machine_id, EV.machine_id);
});
