import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_OMNIRUSH_CLIENT_VERSION, resolveOmniRushClientVersion } from "../src/lib/client-version.js";

test("OmniRush client version prefers explicit environment overrides", () => {
  assert.equal(resolveOmniRushClientVersion({
    OMNIRUSH_CLIENT_VERSION: "9.9.9",
    OMNIRUSH_VERSION: "8.8.8",
  }), "9.9.9");
  assert.equal(resolveOmniRushClientVersion({ OMNIRUSH_VERSION: "8.8.8" }), "8.8.8");
});

test("OmniRush client version ignores malformed overrides", () => {
  const version = resolveOmniRushClientVersion({
    OMNIRUSH_CLIENT_VERSION: "not a version",
    OMNIRUSH_VERSION: "also invalid",
  });
  assert.match(version, /^[0-9][0-9A-Za-z.+-]{0,31}$/);
});

test("OmniRush client version has a supported fallback", () => {
  assert.match(DEFAULT_OMNIRUSH_CLIENT_VERSION, /^[0-9]+\.[0-9]+\.[0-9]+/);
  assert.match(resolveOmniRushClientVersion({}), /^[0-9]/);
});
