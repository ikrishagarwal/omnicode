import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clientHeaderValue,
  clientUserAgent,
  createRefresher,
  loadAuth,
  saveAuth,
  setClientVersion,
} from "../src/lib/auth.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omnicode-auth-"));
}

function response(status, payload) {
  return new Response(payload === undefined ? null : JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("client identity reports the OmniRush release, not the OmniCode version", () => {
  setClientVersion("2.6.9");
  assert.equal(clientHeaderValue(), "cli/2.6.9");
  assert.match(clientUserAgent(), /^omnirush\/2\.6\.9 \(/);
  setClientVersion("");
});

test("auth.json is readable after a rotated token pair is persisted", async () => {
  const dir = tempDir();
  saveAuth(dir, { accessToken: "access-old", refreshToken: "refresh-old" });
  const calls = [];
  const refresher = createRefresher({
    dir,
    origin: "https://omnirush.ai/omnirush",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(200, { access_token: "access-new", refresh_token: "refresh-new" });
    },
  });

  const outcome = await refresher.recover("access-old");
  assert.deepEqual(outcome, { status: "ok", accessToken: "access-new" });
  assert.equal(calls.length, 1);
  assert.equal(loadAuth(dir).accessToken, "access-new");
  assert.equal(loadAuth(dir).refreshToken, "refresh-new");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8")).refreshInFlight, undefined);
  assert.equal(fs.statSync(path.join(dir, "auth.json")).mode & 0o777, 0o600);
});

test("refresher adopts a newer pair without spending the old refresh token", async () => {
  const dir = tempDir();
  saveAuth(dir, { accessToken: "access-old", refreshToken: "refresh-old" });
  const refresher = createRefresher({
    dir,
    origin: "https://omnirush.ai/omnirush",
    fetchImpl: async () => { throw new Error("network should not be called"); },
  });
  saveAuth(dir, { accessToken: "access-from-other-process", refreshToken: "refresh-from-other-process" });
  assert.deepEqual(await refresher.recover("access-old"), { status: "ok", accessToken: "access-from-other-process" });
});
