import os from "node:os";

import {
  clearPendingFlow,
  deviceAuthorize,
  deviceMe,
  deviceToken,
  openBrowser,
  omniDir,
  pollForToken,
  resolveOrigin,
  saveAuth,
  savePendingFlow,
} from "../lib/auth.js";

function deviceName() {
  return (os.hostname() || "omnicode-cli").split(/[.\s]/)[0].slice(0, 64) || "omnicode-cli";
}

export function loginHelp() {
  return [
    "Usage: omnicode login [--no-open]",
    "",
    "Authenticate this device with OmniRush and save compatible credentials in ~/.omnirush.",
    "",
    "Options:",
    "  --no-open  print the approval URL without launching a browser",
    "  -h, --help show this help",
  ].join("\n");
}

export async function runLogin({ argv = [], env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl = globalThis.fetch, sleep } = {}) {
  if (argv.includes("-h") || argv.includes("--help")) {
    stdout.write(`${loginHelp()}\n`);
    return;
  }
  const unknown = argv.filter((arg) => arg !== "--no-open");
  if (unknown.length) throw new Error(`unknown login option: ${unknown[0]}`);
  const dir = omniDir(env);
  const origin = resolveOrigin(env);
  const authorize = await deviceAuthorize(origin, { deviceName: deviceName(), platform: process.platform, fetchImpl });
  savePendingFlow(dir, {
    device_code: authorize.deviceCode,
    user_code: authorize.userCode,
    verification_uri_complete: authorize.verificationUriComplete,
    origin,
    expires_at: authorize.expiresAt,
    started_at: new Date().toISOString(),
  });

  stdout.write("OmniCode device login\n");
  stdout.write(`  code: ${authorize.userCode}\n`);
  stdout.write(`  open: ${authorize.verificationUriComplete}\n`);
  if (!argv.includes("--no-open")) {
    const opened = await openBrowser(authorize.verificationUriComplete, { env });
    if (opened) stdout.write("  (browser launched — approve there; if it did not open, use the URL above)\n");
    else stdout.write("  (open the URL above in a browser and approve)\n");
  }

  try {
    const tokens = await pollForToken(origin, {
      deviceCode: authorize.deviceCode,
      intervalSec: authorize.intervalSec,
      expiresAt: authorize.expiresAt,
      fetchImpl,
      ...(sleep ? { sleep } : {}),
      onWait: () => stderr.write("."),
    });
    const me = await deviceMe(origin, { accessToken: tokens.accessToken, fetchImpl }).catch(() => null);
    saveAuth(dir, tokens);
    stderr.write("\n");
    const email = typeof me?.email === "string" ? me.email : null;
    stdout.write(email ? `Signed in as ${email}.\n` : "Signed in.\n");
    if (me?.approval_state === "pending") stdout.write("Your account is waiting for approval.\n");
    return { dir, origin, tokens, me };
  } finally {
    clearPendingFlow(dir);
  }
}

// Kept as a named export for tests and future non-interactive callers.
export { deviceToken };
