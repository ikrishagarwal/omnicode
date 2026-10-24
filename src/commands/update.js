import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function updateHelp() {
  return [
    "Usage: omnicode update [--check]",
    "",
    "Fetch and fast-forward this OmniCode git checkout.",
    "Local changes must be committed or stashed before updating.",
    "",
    "Options:",
    "  --check      report whether an update is available without applying it",
    "  -h, --help   show this help",
  ].join("\n");
}

export function runGit(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      shell: false,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const message = stderr.trim() || stdout.trim()
        || `git ${args[0]} failed${signal ? ` (${signal})` : ` with exit code ${code}`}`;
      const error = new Error(message);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function parseArgs(argv) {
  let check = false;
  for (const arg of argv) {
    if (arg === "--check") check = true;
    else if (arg === "-h" || arg === "--help") return { check, help: true };
    else throw new Error(`unknown update option: ${arg}`);
  }
  return { check, help: false };
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export async function runUpdate({
  argv = [],
  stdout = process.stdout,
  repoRoot = PACKAGE_ROOT,
  git = runGit,
} = {}) {
  const { check, help } = parseArgs(argv);
  if (help) {
    stdout.write(`${updateHelp()}\n`);
    return;
  }

  let root;
  try {
    root = (await git(["rev-parse", "--show-toplevel"], { cwd: repoRoot })).stdout.trim();
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("git is required to update OmniCode");
    throw new Error("omnicode update only works from a cloned git checkout");
  }
  const call = (args) => git(args, { cwd: root });

  let branch;
  try {
    branch = (await call(["symbolic-ref", "--short", "HEAD"])).stdout.trim();
  } catch {
    throw new Error("OmniCode checkout is not on a branch; check out a branch before updating");
  }

  let upstream;
  try {
    upstream = (await call(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).stdout.trim();
  } catch {
    throw new Error(`branch ${branch} has no upstream; set one with git branch --set-upstream-to=<remote>/<branch>`);
  }

  const dirty = Boolean((await call(["status", "--porcelain"])).stdout.trim());
  if (dirty && !check) throw new Error("working tree has local changes; commit or stash them before updating");

  try {
    await call(["fetch", "--prune"]);
  } catch (error) {
    throw new Error(`could not fetch updates: ${error.message}`);
  }

  const counts = (await call(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])).stdout
    .trim().split(/\s+/).map(Number);
  const [ahead, behind] = counts;
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
    throw new Error("could not determine whether the checkout is behind its upstream");
  }

  const head = (await call(["rev-parse", "--short", "HEAD"])).stdout.trim();
  stdout.write(`OmniCode checkout: ${root}\n`);
  stdout.write(`Branch: ${branch} (${upstream})\n`);

  if (behind === 0) {
    stdout.write(ahead > 0
      ? `Already up to date with ${upstream} (${head}); ${plural(ahead, "local commit")} not pushed.\n`
      : `Already up to date (${head}).\n`);
    return;
  }

  if (check) {
    if (ahead > 0) {
      stdout.write(`Branch has diverged from ${upstream}: ${plural(ahead, "local commit")} ahead and ${plural(behind, "commit")} behind.\n`);
      stdout.write("Reconcile the local commits before updating.\n");
    } else {
      stdout.write(`Update available: ${plural(behind, "commit")} behind ${upstream}.\n`);
      if (dirty) stdout.write("Local changes are present; commit or stash them before updating.\n");
      stdout.write("Run `omnicode update` to apply.\n");
    }
    return;
  }

  if (ahead > 0) {
    throw new Error(`branch ${branch} has ${plural(ahead, "local commit")} and is ${behind} behind ${upstream}; reconcile them before updating`);
  }

  try {
    await call(["merge", "--ff-only", "@{upstream}"]);
  } catch (error) {
    throw new Error(`fast-forward failed: ${error.message}`);
  }

  const after = (await call(["rev-parse", "--short", "HEAD"])).stdout.trim();
  const commits = (await call(["log", "--format=%h %s", `${head}..${after}`])).stdout.trim();
  const changed = (await call(["diff", "--name-only", `${head}..${after}`])).stdout
    .split(/\r?\n/).filter(Boolean);

  stdout.write(`Updated ${head} -> ${after} (${plural(behind, "commit")})\n`);
  if (commits) {
    for (const line of commits.split(/\r?\n/)) stdout.write(`  ${line}\n`);
  }
  if (changed.some((file) => file === "package.json" || /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(file))) {
    stdout.write("Package metadata or dependencies changed; re-run your package manager or link command if needed.\n");
  }
  stdout.write("Restart the OmniCode proxy to use the new code.\n");
}
