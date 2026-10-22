import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const readme = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");

test("README OpenCode configuration lists all OmniRush models", () => {
  for (const model of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol"]) {
    assert.match(readme, new RegExp(`"${model.replace(".", "\\.")}"`));
  }
  assert.doesNotMatch(readme, /"enabled_providers"\s*:\s*\[\s*"omnicode"\s*\]/);
});
