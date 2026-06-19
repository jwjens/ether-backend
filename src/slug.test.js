'use strict';
const test   = require("node:test");
const assert = require("node:assert");
const { validateSlug, slugify } = require("./slug");

test("valid slugs pass", () => {
  for (const s of ["ab", "rock1029", "kjazz", "wxyz-fm", "abc", "a1b2c3", "my-cool-station"]) {
    assert.deepEqual(validateSlug(s), { ok: true }, s);
  }
});

test("too short / too long rejected as invalid", () => {
  assert.deepEqual(validateSlug("a"), { ok: false, reason: "invalid" });   // 1 char (min is now 2)
  assert.deepEqual(validateSlug("a".repeat(33)), { ok: false, reason: "invalid" });
});

test("uppercase / spaces / bad chars rejected as invalid", () => {
  for (const s of ["Rock", "my station", "under_score", "trail.", "sp ace", "dot.com"]) {
    assert.equal(validateSlug(s).reason, "invalid", s);
  }
});

test("leading / trailing / double hyphen rejected as invalid", () => {
  for (const s of ["-abc", "abc-", "a--b"]) {
    assert.equal(validateSlug(s).reason, "invalid", s);
  }
});

test("reserved slugs rejected with reason 'reserved'", () => {
  for (const s of ["admin", "api", "listen", "dashboard", "login", "station"]) {
    assert.deepEqual(validateSlug(s), { ok: false, reason: "reserved" }, s);
  }
});

test("non-string input is invalid", () => {
  assert.equal(validateSlug(null).reason, "invalid");
  assert.equal(validateSlug(undefined).reason, "invalid");
});

test("slugify normalizes names", () => {
  assert.equal(slugify("Rock 102.9 FM"), "rock-102-9-fm");
  assert.equal(slugify("  KJAZZ!!  "), "kjazz");
  assert.equal(slugify("Café Münich"), "cafe-munich");
  assert.equal(slugify("---weird---"), "weird");
});

test("slugify caps at 32 chars and trims a trailing hyphen", () => {
  const out = slugify("a".repeat(40));
  assert.ok(out.length <= 32);
  assert.ok(!out.endsWith("-"));
});
