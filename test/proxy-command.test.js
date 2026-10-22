import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { saveAuth } from "../src/lib/auth.js";
import { runProxy } from "../src/commands/proxy.js";

test("proxy command explains a port collision", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnicode-proxy-command-"));
  saveAuth(dir, { accessToken: "access", refreshToken: "refresh" });
  const error = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
  await assert.rejects(
    runProxy({
      env: { OMNIRUSH_DIR: dir, OMNIRUSH_ORIGIN: "https://omnirush.ai/omnirush" },
      startProxy: async () => { throw error; },
    }),
    /proxy port 8789 is already in use.*existing OmniCode proxy.*--port/,
  );
});
