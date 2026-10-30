'use strict';
// Step b (docs/link-access-audit-and-email-2026-10-28.md §4.2): every route the server answers is classified in
// src/access/route-access.js as account data (needs a stranger test) or public (with a reason). Read from the running
// app's own router, so a route added anywhere — index.js, a router in routes/ or lib/ — is caught.
const test = require("node:test");
const assert = require("node:assert");
const { startServer } = require("./server-harness");
const { listRoutes } = require("./lib/route-list");
const { ROUTES } = require("../src/access/route-access");

const AREAS = ["platform", "users", "stations", "analytics", "billing", "seats", "library", "sync", "backups", "remote", "park", "jukebox", "link"];
let routes;
test.before(async () => { const h = await startServer(); routes = listRoutes(h.app).map(r => `${r.method} ${r.path}`); await h.close(); });

test("every route is classified (a new route must be added to src/access/route-access.js before it ships)", () => {
  const missing = routes.filter(k => !ROUTES[k]);
  assert.deepEqual(missing, [], `unclassified routes:\n  ${missing.join("\n  ")}`);
});

test("every entry is a route that exists (no stale lines)", () => {
  const have = new Set(routes);
  const stale = Object.keys(ROUTES).filter(k => !have.has(k));
  assert.deepEqual(stale, [], `listed but not served:\n  ${stale.join("\n  ")}`);
});

test("each entry is account (with a known area) or public (with a reason)", () => {
  for (const [k, v] of Object.entries(ROUTES)) {
    if (v.access === "account") assert.ok(AREAS.includes(v.area), `${k}: unknown area ${v.area}`);
    else { assert.equal(v.access, "public", `${k}: access`); assert.ok(typeof v.why === "string" && v.why.length > 8, `${k}: public needs a reason`); }
  }
});

test("the inventory's size is what was reviewed (194 routes: account and public)", () => {
  const n = (a) => Object.values(ROUTES).filter(v => v.access === a).length;
  assert.equal(routes.length, 194);
  console.log(`routes ${routes.length}: account ${n("account")}, public ${n("public")}`);
});
