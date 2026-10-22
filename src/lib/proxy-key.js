import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { ensurePrivateDir, writeFileAtomicSync } from "./atomic-file.js";

const PROXY_KEY_FILE = "proxy-key";
const PROXY_KEY_PATTERN = /^[0-9a-f]{64}$/;

export function proxyKeyPath(dir) {
  return path.join(dir, PROXY_KEY_FILE);
}

function repairMode(filePath) {
  if (process.platform !== "win32") {
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
  }
}

/**
 * Load the stable local proxy credential, creating it on first use.
 *
 * This key is deliberately separate from the cloud access/refresh pair. It
 * authenticates only callers on the loopback proxy and is never sent upstream.
 */
export function loadOrCreateProxyKey(dir) {
  ensurePrivateDir(dir);
  const filePath = proxyKeyPath(dir);
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${filePath} must be a regular file`);
    const value = fs.readFileSync(filePath, "utf8").trim();
    if (!PROXY_KEY_PATTERN.test(value)) throw new Error(`${filePath} is invalid; delete it and run omnicode proxy again`);
    repairMode(filePath);
    return value;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const key = randomBytes(32).toString("hex");
  writeFileAtomicSync(filePath, `${key}\n`, { mode: 0o600 });
  return key;
}
