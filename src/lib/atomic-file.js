import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  }
}

export function writeFileAtomicSync(filePath, data, { mode = 0o600 } = {}) {
  const dir = path.dirname(filePath);
  ensurePrivateDir(dir);
  const temporary = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(temporary, "wx", mode);
    fs.writeFileSync(fd, data);
    try { fs.fsyncSync(fd); } catch { /* best effort */ }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, filePath);
    if (process.platform !== "win32") {
      try { fs.chmodSync(filePath, mode); } catch { /* best effort */ }
    }
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

export function writeJsonAtomicSync(filePath, value, options = {}) {
  writeFileAtomicSync(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}
