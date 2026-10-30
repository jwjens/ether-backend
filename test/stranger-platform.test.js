'use strict';
// Stranger tests: platform (operator console). Only a platform token is admitted; every one of B's credentials is refused.
const assert = require("node:assert");
const jwt = require("jsonwebtoken");
const { runArea } = require("./lib/stranger");
runArea("platform", {
  controls: [["GET /api/platform/accounts/:id/stations", (A, t) => ({ headers: { authorization: `Bearer ${jwt.sign({ platform: true }, "test-jwt-secret")}` } }),
    (r, A) => assert.ok(r.text.includes(A.uuid), "the platform token sees account A — so B's refusals are about B, not an empty table")]],
});
