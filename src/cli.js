#!/usr/bin/env node

import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runLogin, loginHelp } from "./commands/login.js";
import { runProxy, proxyHelp } from "./commands/proxy.js";
import { setClientVersion } from "./lib/auth.js";

const VERSION = "1.0.0";
setClientVersion(VERSION);

function help() {
  return [
    "Usage: omnicode <command>",
    "",
    "Commands:",
    "  login   authenticate this device with OmniRush",
    "  proxy   start a local token-injecting proxy",
    "",
    "Run `omnicode <command> --help` for command details.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  const [command, ...args] = argv;
  if (!command || command === "-h" || command === "--help") {
    io.stdout.write(`${help()}\n`);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === "login") {
    await runLogin({ argv: args, stdout: io.stdout, stderr: io.stderr });
    return 0;
  }
  if (command === "proxy") {
    await runProxy({ argv: args, stdout: io.stdout });
    return 0;
  }
  if (command === "login-help") {
    io.stdout.write(`${loginHelp()}\n`);
    return 0;
  }
  if (command === "proxy-help") {
    io.stdout.write(`${proxyHelp()}\n`);
    return 0;
  }
  throw new Error(`unknown command: ${command}`);
}

// if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
main().catch((error) => {
  process.stderr.write(`omnicode: ${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
// }
