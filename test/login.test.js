import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runLogin } from "../src/commands/login.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omnicode-login-"));
}

function output() {
  let value = "";
  return { stream: { write(chunk) { value += String(chunk); } }, text: () => value };
}

test("login saves the official device credential shape without telemetry files", async () => {
  const dir = tempDir();
  const env = {
    OMNIRUSH_DIR: dir,
    OMNIRUSH_ORIGIN: "https://omnirush.ai/omnirush",
  };
  const stdout = output();
  const stderr = output();
  let tokenPolls = 0;
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.endsWith("/device/authorize")) {
      assert.equal(body.platform, process.platform);
      return new Response(JSON.stringify({
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri_complete: "https://omnirush.ai/omnirush/device/verify?code=ABCD-EFGH",
        interval: 1,
        expires_in: 120,
        gateway_url: "https://omnirush.ai/omnirush/v1",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/device/token")) {
      tokenPolls++;
      assert.equal(body.device_code, "device-code");
      return new Response(JSON.stringify(tokenPolls === 1
        ? { detail: "authorization_pending" }
        : { access_token: "access-login", refresh_token: "refresh-login", gateway_url: "https://omnirush.ai/omnirush/v1" }), {
        status: tokenPolls === 1 ? 428 : 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/device/me")) {
      assert.equal(init.headers.Authorization, "Bearer access-login");
      return new Response(JSON.stringify({ id: "account-id", email: "user@example.test" }), { status: 200 });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  await runLogin({
    argv: ["--no-open"],
    env,
    stdout: stdout.stream,
    stderr: stderr.stream,
    fetchImpl,
    sleep: async () => {},
  });

  const auth = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
  assert.equal(auth.accessToken, "access-login");
  assert.equal(auth.refreshToken, "refresh-login");
  assert.equal(auth.gatewayUrl, "https://omnirush.ai/omnirush");
  assert.equal(fs.existsSync(path.join(dir, "device-flow.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "analytics.json")), false);
  assert.match(stdout.text(), /Signed in as user@example\.test/);
  assert.match(stderr.text(), /\./);
});
