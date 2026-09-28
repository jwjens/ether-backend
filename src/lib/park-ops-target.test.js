'use strict';
// Web remote — the Park Ops routes (the phone's cart wall and tonight's closing time) stamp their target EXACTLY as
// /api/cmd does: from the station's raw source_machine_id, through the one stamping function. Before this they
// emitted ops:set-closing / cart:fire with no target, so a desktop that requires one (slice 3) would ignore them.
// Refusals reach the phone as a sentence in `error` (the Park Ops page shows `error` verbatim) plus a `code`.
// Run:  node --test src/lib/park-ops-target.test.js
const test   = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { parkOpsRefusal } = require("./cmd-bus");

const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const route = (needle) => { const a = src.indexOf(needle); return src.slice(a, src.indexOf("\n});\n", a)); };

test("no machine has ever sourced the station → 409 no_source_machine, in words", () => {
  const r = parkOpsRefusal({ status: 409, error: "no_source_machine" });
  assert.equal(r.status, 409);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, "no_source_machine");
  assert.match(r.body.error, /No computer has put this station on air yet/);
});

test("the sourcing machine is not connected → 409 target_offline, naming it", () => {
  const r = parkOpsRefusal({ status: 409, body: { error: "target_offline", machine: "ovowforestmusic", offline_since: "2026-09-27T10:00:00Z" } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "target_offline");
  assert.equal(r.body.machine, "ovowforestmusic");
  assert.match(r.body.error, /ovowforestmusic is not connected right now — nothing was sent/);
});

test("both Park Ops routes stamp through the SAME function /api/cmd uses, and refuse instead of emitting untargeted", () => {
  for (const needle of ['app.put("/public/ops/:slug/closing-time"', 'app.post("/public/ops/:slug/fire"']) {
    const body = route(needle);
    assert.match(body, /await stampStationCommand\(/, needle);
    assert.match(body, /parkOpsRefusal\(/, needle);
    assert.match(body, /target_connected === false/, needle);
  }
  assert.match(route('app.post("/api/cmd", async'), /await stampStationCommand\(licenseId, cmd, req\.body\)/);
});

test("closing time: the display mirror is written only AFTER the command was delivered", () => {
  const body = route('app.put("/public/ops/:slug/closing-time"');
  const refusal = body.indexOf("target_connected === false"), mirror = body.indexOf("INSERT INTO station_cc_data");
  assert.ok(refusal > 0 && mirror > 0, "both present");
  assert.ok(refusal < mirror, "refusal returns before the mirror write");
});
