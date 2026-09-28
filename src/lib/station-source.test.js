'use strict';
// Web remote slice 2 (backend) — the station list says who sourced the stream LAST, even after it went quiet.
// source_machine_id / _name stay the FRESH view (null once the source stops affirming, 90 s); the raw sticky columns
// are exposed alongside as last_source_machine_id / last_source_machine_name / last_source_at, always — so the
// page can say "last sourced from <machine> · offline since <time>" and name who Restart / Stop will reach.
// Run:  node --test src/lib/station-source.test.js
const test   = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { sourceFields, HEARTBEAT_STALE_MS } = require("../station-state");

const fresh = new Date().toISOString();
const stale = new Date(Date.now() - HEARTBEAT_STALE_MS - 1000).toISOString();

test("fresh source: both views agree", () => {
  assert.deepEqual(sourceFields({ source_machine_id: "ov", source_machine_id_at: fresh, source_machine_name: "ovowforestmusic" }), {
    source_machine_id: "ov", source_machine_name: "ovowforestmusic",
    last_source_machine_id: "ov", last_source_machine_name: "ovowforestmusic", last_source_at: fresh,
  });
});

test("stream down: the fresh view is null, the last sourcer is still named", () => {
  assert.deepEqual(sourceFields({ source_machine_id: "ov", source_machine_id_at: stale, source_machine_name: "ovowforestmusic" }), {
    source_machine_id: null, source_machine_name: null,
    last_source_machine_id: "ov", last_source_machine_name: "ovowforestmusic", last_source_at: stale,
  });
});

test("never sourced: everything null", () => {
  assert.deepEqual(sourceFields({}), { source_machine_id: null, source_machine_name: null, last_source_machine_id: null, last_source_machine_name: null, last_source_at: null });
});

test("both station-list endpoints use it (one shape, no drift)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  for (const needle of ['app.get("/api/account/stations", requireAuth,', 'app.get("/api/accounts/:accountId/stations", requireMember(),']) {
    const a = src.indexOf(needle);
    assert.ok(a > 0, needle);
    const route = src.slice(a, src.indexOf("\n});\n", a));
    assert.match(route, /\.\.\.sourceFields\(r\),/, needle);
  }
});
