import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadOrCreateProxyKey, proxyKeyPath } from "../src/lib/proxy-key.js";

test("proxy key is created once and remains private", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnicode-proxy-key-"));
  const first = loadOrCreateProxyKey(dir);
  const second = loadOrCreateProxyKey(dir);

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(second, first);
  assert.equal(fs.readFileSync(proxyKeyPath(dir), "utf8"), `${first}\n`);
  assert.equal(fs.statSync(proxyKeyPath(dir)).mode & 0o777, 0o600);
});

test("invalid proxy key files fail closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnicode-proxy-key-"));
  fs.writeFileSync(proxyKeyPath(dir), "not-a-key\n", { mode: 0o600 });
  assert.throws(() => loadOrCreateProxyKey(dir), /proxy-key is invalid/);
});
