import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("--version reports both the OmniCode and OmniRush versions", () => {
  const output = execFileSync(process.execPath, [path.join(process.cwd(), "src/cli.js"), "--version"], {
    encoding: "utf8",
    env: { ...process.env, OMNIRUSH_CLIENT_VERSION: "9.9.9" },
  });
  assert.equal(output, "omnicode 1.0.0\nomnirush 9.9.9\n");
});
