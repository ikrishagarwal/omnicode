// Adapted from the OmniRush CLI auth module for OmniCode.
// This file is modified for telemetry-free device-flow and credential-store compatibility.
//
// This module intentionally contains only the authentication contract needed
// by OmniCode. It does not import analytics, crash reporting, session capture,
// or any other product instrumentation.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensurePrivateDir, writeFileAtomicSync } from "./atomic-file.js";
import { isRetryableStatus, retryAttempts, withRetries } from "./retry.js";

export const DEFAULT_ORIGIN = "https://omnirush.ai/omnirush";
export const DEFAULT_POLL_INTERVAL_SEC = 5;
export const MAX_POLL_INTERVAL_SEC = 30;
export const ROTATION_GRACE_MS = 120_000;
export const CLIENT_HEADER = "X-OmniRush-Client";

const AUTH_FILE = "auth.json";
const PENDING_FILE = "device-flow.json";
const REFRESH_LOCK_FILE = ".refresh-lock";
const REFRESH_LOCK_STALE_MS = 30_000;
const REFRESH_LOCK_WAIT_MS = 130_000;
const REFRESH_LOCK_POLL_MS = 100;
const REFRESH_ATTEMPT_TIMEOUT_MS = 45_000;

let clientVersion = "";

export function setClientVersion(version) {
  clientVersion = String(version ?? "").trim();
}

export function clientUserAgent(env = process.env) {
  const version = clientVersion || String(env.OMNICODE_VERSION || env.OMNIRUSH_VERSION || "").trim() || "unknown";
  return `omnirush/${version} (${process.platform}; ${process.arch})`;
}

export function clientHeaderValue(env = process.env) {
  const version = clientVersion || String(env.OMNICODE_VERSION || env.OMNIRUSH_VERSION || "").trim();
  return /^[0-9][0-9A-Za-z.+-]{0,31}$/.test(version) ? `cli/${version}` : null;
}

export function clientHeaders(env = process.env) {
  const value = clientHeaderValue(env);
  return value ? { [CLIENT_HEADER]: value } : {};
}

function apiHeaders(extra = {}) {
  return { "User-Agent": clientUserAgent(), ...clientHeaders(), ...extra };
}

export function omniDir(env = process.env) {
  return env.OMNIRUSH_DIR ? path.resolve(env.OMNIRUSH_DIR) : path.join(os.homedir(), ".omnirush");
}

export function authFilePath(dir) {
  return path.join(dir, AUTH_FILE);
}

export function originFromGatewayUrl(gatewayUrl) {
  return String(gatewayUrl || "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function gatewayUrlForOrigin(origin) {
  return `${String(origin).replace(/\/+$/, "")}/v1`;
}

export function resolveOrigin(env = process.env) {
  const direct = String(env.OMNIRUSH_ORIGIN || "").trim().replace(/\/+$/, "");
  if (direct) return direct;
  const viaGateway = originFromGatewayUrl(env.OMNIRUSH_GATEWAY_URL);
  return viaGateway || DEFAULT_ORIGIN;
}

export function resolveGatewayUrl(env = process.env, authGatewayUrl) {
  const override = String(env.OMNIRUSH_GATEWAY_URL || "").trim();
  if (override) return override;
  const origin = String(env.OMNIRUSH_ORIGIN || "").trim().replace(/\/+$/, "");
  if (origin) return gatewayUrlForOrigin(origin);
  return authGatewayUrl ? gatewayUrlForOrigin(originFromGatewayUrl(authGatewayUrl)) : gatewayUrlForOrigin(DEFAULT_ORIGIN);
}

function isLoopbackHost(host) {
  const name = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return name === "localhost" || name === "::1" || /^127(?:\.\d{1,3}){3}$/.test(name);
}

/** Validate manager-supplied URLs before accepting a gateway or browser page. */
export function trustedManagerUrl(value, origin = resolveOrigin()) {
  let url;
  let base;
  try {
    url = new URL(String(value ?? "").trim());
    base = new URL(String(origin ?? "").trim());
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const baseHost = base.hostname.toLowerCase();
  const sameHost = host === baseHost || (isLoopbackHost(host) && isLoopbackHost(baseHost));
  const officialHost = host === "omnirush.ai" || host.endsWith(".omnirush.ai");
  const officialBase = baseHost === "omnirush.ai" || baseHost.endsWith(".omnirush.ai");
  if (!sameHost && !(officialBase && officialHost)) return null;
  if (url.protocol === "http:" && base.protocol !== "http:") return null;
  return url;
}

export function trustedGatewayOrigin(value, origin = resolveOrigin()) {
  const url = trustedManagerUrl(value, origin);
  return url ? originFromGatewayUrl(url.href) : undefined;
}

function repairMode(filePath, mode = 0o600) {
  if (process.platform !== "win32") {
    try { fs.chmodSync(filePath, mode); } catch { /* best effort */ }
  }
}

function readJson(filePath) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (attempt === 3) return null;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (attempt + 1)); } catch { /* best effort */ }
    }
  }
  return null;
}

export function tokenFingerprint(token) {
  return createHash("sha256").update(String(token)).digest("hex").slice(0, 16);
}

function markerFor(value, refreshToken) {
  return value && typeof value === "object" && value.token === tokenFingerprint(refreshToken) ? value : null;
}

export function readAuthState(dir) {
  const filePath = authFilePath(dir);
  const value = readJson(filePath);
  const empty = { auth: null, unreadable: false, inFlight: null, dead: null };
  if (value === null) return { ...empty, unreadable: fs.existsSync(filePath) };
  if (!value || typeof value !== "object") return empty;
  const accessToken = typeof value.accessToken === "string" ? value.accessToken : "";
  const refreshToken = typeof value.refreshToken === "string" ? value.refreshToken : "";
  if (!accessToken || !refreshToken) return empty;
  const gatewayUrl = value.gatewayUrl ? trustedGatewayOrigin(value.gatewayUrl, resolveOrigin()) : undefined;
  repairMode(filePath);
  return {
    auth: { accessToken, refreshToken, ...(gatewayUrl ? { gatewayUrl } : {}) },
    unreadable: false,
    inFlight: markerFor(value.refreshInFlight, refreshToken),
    dead: markerFor(value.refreshDead, refreshToken),
  };
}

export function loadAuth(dir) {
  return readAuthState(dir).auth;
}

export function saveAuth(dir, auth, { refreshInFlight, refreshDead } = {}) {
  if (!auth?.accessToken || !auth?.refreshToken) throw new Error("refusing to store incomplete omnicode credentials");
  ensurePrivateDir(dir);
  writeFileAtomicSync(authFilePath(dir), JSON.stringify({
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    ...(auth.gatewayUrl ? { gatewayUrl: auth.gatewayUrl } : {}),
    savedAt: new Date().toISOString(),
    ...(refreshInFlight ? { refreshInFlight } : {}),
    ...(refreshDead ? { refreshDead } : {}),
  }, null, 2) + "\n");
}

export function savePendingFlow(dir, flow) {
  ensurePrivateDir(dir);
  writeFileAtomicSync(path.join(dir, PENDING_FILE), JSON.stringify(flow, null, 2) + "\n");
}

export function clearPendingFlow(dir) {
  try { fs.rmSync(path.join(dir, PENDING_FILE), { force: true }); } catch { /* best effort */ }
}

function detailOf(payload, fallback = "") {
  if (payload && typeof payload === "object" && typeof payload.detail === "string") return payload.detail;
  return fallback;
}

async function postJson(url, body, fetchImpl = globalThis.fetch) {
  const outcome = await withRetries(async () => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: apiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* non-JSON response */ }
    return { response, payload };
  }, { attempts: retryAttempts(), isRetryable: ({ response }) => isRetryableStatus(response?.status) });
  if (outcome.error) throw outcome.error;
  return outcome.result;
}

export async function deviceAuthorize(origin, { deviceName, platform = process.platform, fetchImpl = globalThis.fetch } = {}) {
  const { response, payload } = await postJson(`${origin}/device/authorize`, {
    device_name: deviceName || (os.hostname() || "omnicode-cli").split(/[.\s]/)[0].slice(0, 64),
    platform,
  }, fetchImpl);
  if (!response.ok) throw new Error(`device authorize failed: HTTP ${response.status} ${detailOf(payload)}`.trim());
  const deviceCode = typeof payload?.device_code === "string" ? payload.device_code : "";
  const userCode = typeof payload?.user_code === "string" ? payload.user_code : "";
  const verificationUriComplete = typeof payload?.verification_uri_complete === "string" ? payload.verification_uri_complete : "";
  if (!deviceCode || !userCode || !verificationUriComplete) {
    throw new Error("device authorize response missing device_code/user_code/verification_uri_complete");
  }
  const page = trustedManagerUrl(verificationUriComplete, origin);
  if (!page) throw new Error("device authorize response named an untrusted sign-in page; not opening it");
  const verificationUri = typeof payload.verification_uri === "string" && trustedManagerUrl(payload.verification_uri, origin)
    ? payload.verification_uri
    : undefined;
  const intervalSec = typeof payload.interval === "number" && payload.interval > 0 ? payload.interval : DEFAULT_POLL_INTERVAL_SEC;
  const expiresInSec = typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : 600;
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: page.href,
    intervalSec,
    expiresAt: Date.now() + expiresInSec * 1000,
  };
}

export async function deviceToken(origin, { deviceCode, fetchImpl = globalThis.fetch } = {}) {
  const { response, payload } = await postJson(`${origin}/device/token`, { device_code: deviceCode }, fetchImpl);
  const detail = detailOf(payload);
  if (response.ok) {
    const accessToken = typeof payload?.access_token === "string" ? payload.access_token : "";
    const refreshToken = typeof payload?.refresh_token === "string" ? payload.refresh_token : "";
    if (!accessToken || !refreshToken) return { status: "error", detail: "token response missing access_token/refresh_token" };
    const gatewayUrl = trustedGatewayOrigin(payload?.gateway_url, origin);
    return { status: "ok", tokens: { accessToken, refreshToken, ...(gatewayUrl ? { gatewayUrl } : {}) } };
  }
  if (response.status === 428 || detail === "authorization_pending") return { status: "pending" };
  if (response.status === 429 || detail === "slow_down") return { status: "slow_down" };
  if (detail === "expired_token") return { status: "expired" };
  return { status: "error", detail: `HTTP ${response.status} ${detail}`.trim() };
}

export async function pollForToken(origin, {
  deviceCode,
  intervalSec = DEFAULT_POLL_INTERVAL_SEC,
  expiresAt = Date.now() + 600_000,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onWait,
} = {}) {
  let interval = Math.min(Math.max(intervalSec, 1), MAX_POLL_INTERVAL_SEC);
  for (;;) {
    if (Date.now() >= expiresAt) throw new Error("device authorization expired — run `omnicode login` again");
    const result = await deviceToken(origin, { deviceCode, fetchImpl });
    if (result.status === "ok") return result.tokens;
    if (result.status === "expired") throw new Error("device authorization expired — run `omnicode login` again");
    if (result.status === "error") throw new Error(`device token poll failed: ${result.detail}`);
    if (result.status === "slow_down") interval = Math.min(interval + 5, MAX_POLL_INTERVAL_SEC);
    onWait?.(interval);
    await sleep(interval * 1000);
  }
}

export async function deviceMe(origin, { accessToken, fetchImpl = globalThis.fetch } = {}) {
  const outcome = await withRetries(async () => ({
    response: await fetchImpl(`${origin}/device/me`, {
      headers: apiHeaders({ Authorization: `Bearer ${accessToken}` }),
      signal: AbortSignal.timeout(15_000),
    }),
  }), { attempts: retryAttempts(), isRetryable: ({ response }) => isRetryableStatus(response?.status) });
  if (outcome.error) throw outcome.error;
  const response = outcome.result.response;
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`device me failed: HTTP ${response.status}`);
  return response.json();
}

export class RefreshRejectedError extends Error {
  constructor(detail, status) {
    super(`device refresh failed: HTTP ${status} ${detail}`.trim());
    this.name = "RefreshRejectedError";
    this.status = status;
    this.detail = detail;
  }
}

export class RefreshUnansweredError extends Error {
  constructor(message, { mayHaveRotated = true, retryAfterSec } = {}) {
    super(message);
    this.name = "RefreshUnansweredError";
    this.mayHaveRotated = mayHaveRotated;
    this.retryAfterSec = retryAfterSec;
  }
}

export async function refreshTokens(origin, { refreshToken, fetchImpl = globalThis.fetch, timeoutMs = REFRESH_ATTEMPT_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetchImpl(`${origin}/device/refresh`, {
      method: "POST",
      headers: apiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new RefreshUnansweredError(`device refresh failed: ${error?.name || "network error"}`, { mayHaveRotated: true });
  }
  let payload = null;
  try { payload = await response.json(); } catch { /* non-JSON response */ }
  if (!response.ok) {
    if ([400, 401, 403, 409].includes(response.status)) throw new RefreshRejectedError(detailOf(payload, `HTTP ${response.status}`), response.status);
    throw new RefreshUnansweredError(`device refresh failed: HTTP ${response.status}`, {
      mayHaveRotated: true,
      retryAfterSec: Number(response.headers?.get?.("retry-after")) || undefined,
    });
  }
  const accessToken = typeof payload?.access_token === "string" ? payload.access_token : "";
  const nextRefreshToken = typeof payload?.refresh_token === "string" ? payload.refresh_token : "";
  if (!accessToken || !nextRefreshToken) throw new RefreshUnansweredError("refresh response missing access_token/refresh_token");
  const gatewayUrl = trustedGatewayOrigin(payload?.gateway_url, origin);
  return { accessToken, refreshToken: nextRefreshToken, ...(gatewayUrl ? { gatewayUrl } : {}) };
}

function processIsGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockIsStale(lockPath, info) {
  if (info?.host === os.hostname() && processIsGone(info.pid)) return true;
  try { return Date.now() - fs.statSync(lockPath).mtimeMs > REFRESH_LOCK_STALE_MS; } catch { return true; }
}

export async function acquireRefreshLock(dir, { waitMs = REFRESH_LOCK_WAIT_MS, sleepMs = REFRESH_LOCK_POLL_MS } = {}) {
  ensurePrivateDir(dir);
  const lockPath = path.join(dir, REFRESH_LOCK_FILE);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now(), id: randomUUID() }));
      fs.closeSync(fd);
      return { path: lockPath };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const info = readJson(lockPath);
      if (lockIsStale(lockPath, info)) {
        try { fs.rmSync(lockPath, { force: true }); } catch { /* another holder may win */ }
        continue;
      }
      if (Date.now() >= deadline) return null;
      await sleep(sleepMs);
    }
  }
}

export function releaseRefreshLock(handle) {
  if (!handle?.path) return;
  try { fs.rmSync(handle.path, { force: true }); } catch { /* best effort */ }
}

function deadOutcome(marker) {
  return { status: "dead", reason: marker?.reason === "account" ? "account" : "session", detail: marker?.detail || "refresh_token_invalid_or_expired" };
}

export function storedSessionEnded(dir) {
  const state = readAuthState(dir);
  if (!state.auth) return null;
  if (state.dead) return deadOutcome(state.dead);
  if (state.inFlight && Date.now() - state.inFlight.since >= ROTATION_GRACE_MS) {
    return { status: "dead", reason: "interrupted", detail: "refresh_answer_lost" };
  }
  return null;
}

export function createRefresher({ dir, origin, fetchImpl = globalThis.fetch } = {}) {
  let memory = dir ? loadAuth(dir) : null;
  let inflight = null;
  const reload = () => {
    if (dir) {
      const state = readAuthState(dir);
      if (state.auth) memory = state.auth;
      else if (!state.unreadable) memory = null;
    }
    return memory;
  };
  const ok = (auth) => ({ status: "ok", accessToken: auth.accessToken });
  const signedOut = () => ({ status: "dead", reason: "signed_out", detail: "no stored credentials" });

  const recoverOnce = async (tokenUsed) => {
    const latest = reload();
    if (!latest) return signedOut();
    if (latest.accessToken !== tokenUsed) return ok(latest);
    if (!dir) {
      try {
        const next = await refreshTokens(origin, { refreshToken: latest.refreshToken, fetchImpl });
        memory = next;
        return ok(next);
      } catch (error) {
        return { status: "dead", reason: error instanceof RefreshRejectedError && error.status === 403 ? "account" : "session", detail: error.detail || error.message };
      }
    }
    const lock = await acquireRefreshLock(dir);
    if (!lock) return { status: "transient", error: "could not take the sign-in refresh lock" };
    try {
      const state = readAuthState(dir);
      const base = state.auth;
      if (!base) return state.unreadable ? { status: "transient", error: "auth.json cannot be read right now" } : signedOut();
      if (base.accessToken !== tokenUsed) {
        memory = base;
        return ok(base);
      }
      if (state.dead) return deadOutcome(state.dead);
      const marker = { token: tokenFingerprint(base.refreshToken), since: Date.now(), pid: process.pid, host: os.hostname(), id: randomUUID(), sent: 1 };
      saveAuth(dir, base, { refreshInFlight: marker });
      try {
        const next = await refreshTokens(origin, { refreshToken: base.refreshToken, fetchImpl });
        saveAuth(dir, next);
        memory = next;
        return ok(next);
      } catch (error) {
        if (error instanceof RefreshRejectedError && error.status === 409) {
          const after = readAuthState(dir).auth;
          if (after && after.refreshToken !== base.refreshToken) {
            memory = after;
            return ok(after);
          }
        }
        if (error instanceof RefreshRejectedError && [401, 403].includes(error.status)) {
          const reason = error.status === 403 ? "account" : "session";
          saveAuth(dir, base, { refreshDead: { token: tokenFingerprint(base.refreshToken), at: new Date().toISOString(), reason, detail: error.detail } });
          return { status: "dead", reason, detail: error.detail };
        }
        saveAuth(dir, base);
        return { status: "transient", error: error?.message || String(error) };
      }
    } finally {
      releaseRefreshLock(lock);
    }
  };

  const recover = async (tokenUsed) => {
    while (inflight) await inflight.catch(() => undefined);
    inflight = recoverOnce(tokenUsed);
    try { return await inflight; } finally { inflight = null; }
  };

  return {
    get auth() { return reload(); },
    accessToken() { return reload()?.accessToken || ""; },
    reload,
    setAuth(next) { memory = next; },
    recover,
    async refresh(expectedAccessToken) { return (await recover(expectedAccessToken)).status === "ok"; },
  };
}

/** Best-effort browser launch. The printed URL remains the source of truth. */
export async function openBrowser(url, { platform = process.platform, env = process.env } = {}) {
  const page = trustedManagerUrl(url, resolveOrigin(env));
  if (!page) return false;
  const command = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", page.href] : [page.href];
  return await new Promise((resolve) => {
    let child;
    try { child = spawn(command, args, { detached: true, stdio: "ignore", env }); } catch { resolve(false); return; }
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; try { child.unref(); } catch { /* best effort */ } resolve(value); };
    child.once("error", () => finish(false));
    const timer = setTimeout(() => finish(true), 800);
    timer.unref?.();
  });
}
