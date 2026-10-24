import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { runUpdate } from "../src/commands/update.js";

function output() {
  let value = "";
  return { stream: { write(chunk) { value += String(chunk); } }, text: () => value };
}

function fakeGit(responses) {
  const calls = [];
  const git = async (args, { cwd } = {}) => {
    calls.push({ args, cwd });
    const key = args.join(" ");
    const response = responses[key];
    if (typeof response === "function") return response({ args, cwd });
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`unexpected git call: ${key}`);
    return { stdout: response, stderr: "" };
  };
  return { git, calls };
}

function responses(overrides = {}) {
  return {
    "rev-parse --show-toplevel": "/tmp/omnicode\n",
    "symbolic-ref --short HEAD": "main\n",
    "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": "origin/main\n",
    "status --porcelain": "",
    "fetch --prune": "",
    "rev-list --left-right --count HEAD...@{upstream}": "0\t0\n",
    "rev-parse --short HEAD": "b9db7ca\n",
    ...overrides,
  };
}

test("update --help explains the command without touching git", async () => {
  const stdout = output();
  const { git, calls } = fakeGit(responses());
  await runUpdate({ argv: ["--help"], stdout: stdout.stream, git });
  assert.match(stdout.text(), /Usage: omnicode update \[--check\]/);
  assert.match(stdout.text(), /Local changes must be committed or stashed/);
  assert.equal(calls.length, 0);
});

test("update refuses a checkout with local changes", async () => {
  const stdout = output();
  const { git, calls } = fakeGit(responses({ "status --porcelain": " M src/cli.js\n" }));
  await assert.rejects(
    runUpdate({ argv: [], stdout: stdout.stream, git }),
    /working tree has local changes; commit or stash/,
  );
  assert.equal(calls.some(({ args }) => args[0] === "fetch"), false);
  assert.equal(calls.some(({ args }) => args[0] === "merge"), false);
});

test("update --check reports available commits without applying them", async () => {
  const stdout = output();
  const { git, calls } = fakeGit(responses({
    "status --porcelain": " M README.md\n",
    "rev-list --left-right --count HEAD...@{upstream}": "0\t2\n",
  }));
  await runUpdate({ argv: ["--check"], stdout: stdout.stream, git });
  assert.match(stdout.text(), /Update available: 2 commits behind origin\/main/);
  assert.match(stdout.text(), /Local changes are present/);
  assert.match(stdout.text(), /Run `omnicode update` to apply/);
  assert.equal(calls.some(({ args }) => args[0] === "merge"), false);
});

test("update reports an up-to-date checkout", async () => {
  const stdout = output();
  const { git } = fakeGit(responses());
  await runUpdate({ argv: [], stdout: stdout.stream, git });
  assert.match(stdout.text(), /Already up to date \(b9db7ca\)/);
});

test("update fast-forwards and lists the new commits", async () => {
  const stdout = output();
  const heads = ["b9db7ca\n", "abc1234\n"];
  const { git, calls } = fakeGit(responses({
    "rev-list --left-right --count HEAD...@{upstream}": "0\t2\n",
    "rev-parse --short HEAD": () => ({ stdout: heads.shift(), stderr: "" }),
    "merge --ff-only @{upstream}": "",
    "log --format=%h %s b9db7ca..abc1234": "abc1234 feat: add update command\n",
    "diff --name-only b9db7ca..abc1234": "src/cli.js\nREADME.md\n",
  }));
  await runUpdate({ argv: [], stdout: stdout.stream, git });
  assert.match(stdout.text(), /Updated b9db7ca -> abc1234 \(2 commits\)/);
  assert.match(stdout.text(), /abc1234 feat: add update command/);
  assert.match(stdout.text(), /Restart the OmniCode proxy/);
  assert.equal(calls.filter(({ args }) => args[0] === "merge").length, 1);
});

test("update warns when package metadata changed", async () => {
  const stdout = output();
  const heads = ["b9db7ca\n", "abc1234\n"];
  const { git } = fakeGit(responses({
    "rev-list --left-right --count HEAD...@{upstream}": "0\t1\n",
    "rev-parse --short HEAD": () => ({ stdout: heads.shift(), stderr: "" }),
    "merge --ff-only @{upstream}": "",
    "log --format=%h %s b9db7ca..abc1234": "abc1234 chore: update package\n",
    "diff --name-only b9db7ca..abc1234": "package.json\npnpm-lock.yaml\n",
  }));
  await runUpdate({ argv: [], stdout: stdout.stream, git });
  assert.match(stdout.text(), /Package metadata or dependencies changed/);
});

test("update refuses a diverged branch", async () => {
  const stdout = output();
  const { git, calls } = fakeGit(responses({
    "rev-list --left-right --count HEAD...@{upstream}": "1\t2\n",
  }));
  await assert.rejects(
    runUpdate({ argv: [], stdout: stdout.stream, git }),
    /1 local commit and is 2 behind origin\/main/,
  );
  assert.equal(calls.some(({ args }) => args[0] === "merge"), false);
});

test("update explains that a non-git install cannot update itself", async () => {
  const stdout = output();
  const { git } = fakeGit(responses({
    "rev-parse --show-toplevel": new Error("fatal: not a git repository"),
  }));
  await assert.rejects(
    runUpdate({ argv: [], stdout: stdout.stream, git }),
    /only works from a cloned git checkout/,
  );
});

test("update explains a branch without an upstream", async () => {
  const stdout = output();
  const { git } = fakeGit(responses({
    "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": new Error("fatal: no upstream configured"),
  }));
  await assert.rejects(
    runUpdate({ argv: [], stdout: stdout.stream, git }),
    /branch main has no upstream/,
  );
});

test("the CLI exposes the update command", () => {
  const outputText = execFileSync(process.execPath, [path.join(process.cwd(), "src/cli.js"), "update", "--help"], {
    encoding: "utf8",
  });
  assert.match(outputText, /Usage: omnicode update/);
});
