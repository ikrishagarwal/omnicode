// Telemetry-free loopback token proxy.
//
// The local client receives a persistent local proxy key. OmniRush access
// and refresh tokens stay in auth.json and are injected only into upstream
// requests made by this process.

import http from "node:http";

import { CLIENT_HEADER, clientHeaderValue } from "./auth.js";

const HOP_BY_HOP = new Set([
  "connection",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
]);
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const TERMINAL_GATEWAY_CODES = new Set([
  "daily_grant_exhausted",
  "limit_tokens",
  "limit_session_cap",
  "session_quality_cap",
  "request_policy_refused",
  "cyber_policy",
]);

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function sameSecret(actual, expected) {
  return typeof actual === "string" && typeof expected === "string" && actual === expected;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks, size) : Buffer.alloc(0);
}

function requestTarget(rawUrl) {
  try { return new URL(rawUrl || "/", "http://omnicode.local"); } catch { return null; }
}

function copyResponseHeaders(upstream) {
  const headers = {};
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value;
  });
  return headers;
}

async function sendUpstreamBody(upstream, res) {
  if (!upstream.body) {
    res.end();
    return;
  }
  try {
    for await (const chunk of upstream.body) {
      if (!res.destroyed) res.write(Buffer.from(chunk));
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
}

async function bufferedGatewayError(upstream) {
  if (!(upstream.status === 429 || upstream.status >= 500)) return null;
  const body = Buffer.from(await upstream.arrayBuffer().catch(() => new ArrayBuffer(0)));
  let payload = null;
  try { payload = JSON.parse(body.toString("utf8")); } catch { /* non-JSON error */ }
  const stable = payload?.error?.omnirush;
  const detail = typeof payload?.detail === "string" ? payload.detail : "";
  const code = typeof payload?.error?.code === "string" ? payload.error.code : "";
  const stableCode = typeof stable?.code === "string" ? stable.code : "";
  const headerSaysFinal = String(upstream.headers.get("x-should-retry") || "").toLowerCase() === "false";
  const terminal = stable?.retry === false || headerSaysFinal
    || [detail, code, stableCode].some((value) => TERMINAL_GATEWAY_CODES.has(value));
  if (!terminal) return { body, payload, terminal: false };
  const finalCode = stableCode || code || detail || "gateway_request_refused";
  const message = typeof payload?.error?.message === "string" && payload.error.message.trim()
    ? payload.error.message.trim()
    : detail || finalCode;
  const omnirush = {
    code: stableCode || finalCode,
    retry: false,
    ...(typeof stable?.scope === "string" ? { scope: stable.scope } : {}),
    ...(typeof stable?.resets_at === "string" ? { resets_at: stable.resets_at } : {}),
    ...(typeof payload?.error?.omnirush?.resets_at === "string" ? { resets_at: payload.error.omnirush.resets_at } : {}),
  };
  return {
    terminal: true,
    status: 403,
    body: Buffer.from(JSON.stringify({
      error: {
        type: "invalid_request_error",
        code: finalCode,
        message,
        omnirush,
      },
    })),
  };
}

/**
 * Start the fixed-port loopback proxy.
 *
 * Resolves { url, port, baseURL, close }. The gateway path is retained so a
 * client configured with baseURL `${baseURL}` can use relative /models and
 * /responses requests without learning the cloud URL.
 */
export async function startTokenProxy({
  gatewayUrl,
  getToken,
  refreshToken,
  expectedSecret,
  hostname = "127.0.0.1",
  port = 8789,
  // The gateway allowlists the bare product label in User-Agent. The release
  // version, when available, is sent separately as X-OmniRush-Client.
  clientUserAgent: userAgent = "omnirush",
} = {}) {
  const gateway = new URL(String(gatewayUrl));
  if (gateway.protocol !== "https:" && gateway.protocol !== "http:") throw new Error("gateway URL must use http or https");
  const basePath = gateway.pathname.replace(/\/+$/, "");
  if (!basePath) throw new Error("gateway URL must include its API path");
  const upstreamOrigin = gateway.origin;
  const gate = expectedSecret ? `Bearer ${expectedSecret}` : null;

  const server = http.createServer((req, res) => {
    forward(req, res).catch((error) => {
      if (res.headersSent || res.writableEnded) return;
      if (error?.statusCode) json(res, error.statusCode, { error: "token_proxy_request_rejected" });
      else json(res, 502, { error: "token_proxy_upstream_error" });
    });
  });

  async function forward(req, res) {
    if (gate && !sameSecret(req.headers.authorization, gate)) {
      json(res, 403, { error: "token_proxy_forbidden" });
      return;
    }
    const asked = requestTarget(req.url);
    const reqPath = asked?.pathname || "";
    if (!asked || (reqPath !== basePath && !reqPath.startsWith(`${basePath}/`))) {
      json(res, 404, { error: "token_proxy_path_not_allowed" });
      return;
    }
    const token = typeof getToken === "function" ? String(getToken() || "") : "";
    if (!token) {
      json(res, 401, { error: "token_proxy_not_authenticated" });
      return;
    }
    const body = ["GET", "HEAD"].includes((req.method || "GET").toUpperCase()) ? Buffer.alloc(0) : await readBody(req);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(key.toLowerCase()) || ["host", "authorization", "user-agent"].includes(key.toLowerCase())) continue;
      headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
    }
    headers.set("authorization", `Bearer ${token}`);
    headers.set("user-agent", userAgent);
    const named = clientHeaderValue();
    if (named) headers.set(CLIENT_HEADER, named);
    const target = `${upstreamOrigin}${reqPath}${asked.search}`;
    const method = (req.method || "GET").toUpperCase();
    const init = { method, headers };
    if (body.length && method !== "GET" && method !== "HEAD") init.body = body;
    let upstream = await fetch(target, init);
    if (upstream.status === 401 && typeof refreshToken === "function") {
      const fresh = String(await refreshToken(token).catch(() => "") || "");
      if (fresh && fresh !== token) {
        await upstream.body?.cancel?.();
        headers.set("authorization", `Bearer ${fresh}`);
        upstream = await fetch(target, init);
      }
    }
    const buffered = await bufferedGatewayError(upstream);
    if (buffered?.terminal) {
      res.writeHead(buffered.status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-should-retry": "false",
      });
      res.end(buffered.body);
      return;
    }
    if (buffered && !buffered.terminal) {
      res.writeHead(upstream.status, copyResponseHeaders(upstream));
      res.end(buffered.body);
      return;
    }
    res.writeHead(upstream.status, copyResponseHeaders(upstream));
    await sendUpstreamBody(upstream, res);
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${hostname}:${actualPort}`;
  return {
    url,
    port: actualPort,
    baseURL: `${url}${basePath}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
