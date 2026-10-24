import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const DEFAULT_OMNIRUSH_CLIENT_VERSION = "2.6.9";

const VERSION_PATTERN = /^[0-9][0-9A-Za-z.+-]{0,31}$/;

function cleanVersion(value) {
  const version = String(value ?? "").trim();
  return VERSION_PATTERN.test(version) ? version : "";
}

function packageVersion(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return cleanVersion(value?.version);
  } catch {
    return "";
  }
}

function resolveLocalReferenceVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return packageVersion(path.join(here, "..", "..", "omnirush_package", "node_modules", "omnirush", "package.json"));
  } catch {
    return "";
  }
}

function resolveInstalledVersion() {
  try {
    const require = createRequire(import.meta.url);
    return packageVersion(require.resolve("omnirush/package.json"));
  } catch {
    return "";
  }
}

export function resolveOmniRushClientVersion(env = process.env) {
  return cleanVersion(env.OMNIRUSH_CLIENT_VERSION)
    || cleanVersion(env.OMNIRUSH_VERSION)
    || resolveLocalReferenceVersion()
    || resolveInstalledVersion()
    || DEFAULT_OMNIRUSH_CLIENT_VERSION;
}
