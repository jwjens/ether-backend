'use strict';
// Stranger tests: platform (operator console). Only a platform token is admitted; every one of B's credentials is refused.
// The proof each route was reached is a platform token (the console's own credential).
const assert = require("node:assert");
const jwt = require("jsonwebtoken");
const { runArea } = require("./lib/stranger");
const platform = (secret) => [{ name: "platform token", headers: { authorization: `Bearer ${jwt.sign({ platform: true }, secret)}` } }];
runArea("platform", {
  ownCredentials: platform,
  controls: [["GET /api/platform/accounts/:id/stations", () => ({ headers: platform("test-jwt-secret")[0].headers }),
    (r, A) => assert.ok(r.text.includes(A.uuid), "the platform token sees account A — so B's refusals are about B, not an empty table")]],
});
