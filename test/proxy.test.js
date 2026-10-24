import assert from "node:assert/strict";
import http from "node:http";
import { gzipSync } from "node:zlib";
import test from "node:test";

import { setClientVersion } from "../src/lib/auth.js";
import { startTokenProxy } from "../src/lib/proxy.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function request(url, { method = "GET", secret, body } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(parsed, {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("proxy gates local requests, injects tokens, and retries one stale bearer", async () => {
  let currentToken = "access-old";
  let refreshes = 0;
  const upstream = http.createServer((req, res) => {
    if (req.url === "/omnirush/v1/models") {
      assert.equal(req.headers.authorization, `Bearer ${currentToken}`);
      assert.equal(req.headers["user-agent"], "omnirush");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-6-astra" }] }));
      return;
    }
    if (req.url === "/omnirush/v1/responses") {
      if (req.headers.authorization === "Bearer access-old") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "expired" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"ok":true}\n\n');
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const proxy = await startTokenProxy({
    gatewayUrl: `http://127.0.0.1:${upstreamPort}/omnirush/v1`,
    port: 0,
    expectedSecret: "local-secret",
    getToken: () => currentToken,
    refreshToken: async () => {
      refreshes++;
      currentToken = "access-new";
      return currentToken;
    },
  });

  try {
    const forbidden = await request(`${proxy.baseURL}/models`, { secret: "wrong" });
    assert.equal(forbidden.status, 403);
    const models = await request(`${proxy.baseURL}/models`, { secret: "local-secret" });
    assert.equal(models.status, 200);
    assert.deepEqual(JSON.parse(models.body).data[0], { id: "gpt-6-astra" });
    const response = await request(`${proxy.baseURL}/responses`, {
      method: "POST",
      secret: "local-secret",
      body: JSON.stringify({ model: "omnirush/gpt-6-astra", input: "hello" }),
    });
    assert.equal(response.status, 200);
    assert.match(response.body, /DONE/);
    assert.equal(refreshes, 1);
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("proxy rejects paths outside the configured gateway prefix", async () => {
  const upstream = http.createServer((_req, res) => { res.writeHead(200); res.end(); });
  const upstreamPort = await listen(upstream);
  const proxy = await startTokenProxy({
    gatewayUrl: `http://127.0.0.1:${upstreamPort}/omnirush/v1`,
    port: 0,
    expectedSecret: "local-secret",
    getToken: () => "access",
  });
  try {
    const result = await request(`${proxy.url}/omnirush/admin`, { secret: "local-secret" });
    assert.equal(result.status, 404);
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("proxy removes compression headers after fetch decompresses upstream data", async () => {
  const upstream = http.createServer((_req, res) => {
    const body = Buffer.from(JSON.stringify({ ok: true }));
    const compressed = gzipSync(body);
    res.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": compressed.length,
    });
    res.end(compressed);
  });
  const upstreamPort = await listen(upstream);
  const proxy = await startTokenProxy({
    gatewayUrl: `http://127.0.0.1:${upstreamPort}/omnirush/v1`,
    port: 0,
    expectedSecret: "local-secret",
    getToken: () => "access",
  });
  try {
    const result = await request(`${proxy.baseURL}/models`, { secret: "local-secret" });
    assert.equal(result.status, 200);
    assert.equal(result.headers["content-encoding"], undefined);
    assert.deepEqual(JSON.parse(result.body), { ok: true });
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("proxy turns terminal gateway quota errors into non-retryable errors", async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({
      detail: "daily_grant_exhausted",
      error: {
        code: "daily_grant_exhausted",
        omnirush: { code: "limit_tokens", scope: "day", retry: false },
      },
    }));
  });
  const upstreamPort = await listen(upstream);
  const proxy = await startTokenProxy({
    gatewayUrl: `http://127.0.0.1:${upstreamPort}/omnirush/v1`,
    port: 0,
    expectedSecret: "local-secret",
    getToken: () => "access",
  });
  try {
    const result = await request(`${proxy.baseURL}/responses`, { secret: "local-secret" });
    const payload = JSON.parse(result.body);
    assert.equal(result.status, 403);
    assert.equal(result.headers["x-should-retry"], "false");
    assert.equal(payload.error.code, "limit_tokens");
    assert.equal(payload.error.omnirush.retry, false);
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("proxy reports the configured OmniRush client version", async () => {
  setClientVersion("2.6.9");
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers["x-omnirush-client"], "cli/2.6.9");
    assert.equal(req.headers["user-agent"], "omnirush");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const proxy = await startTokenProxy({
    gatewayUrl: `http://127.0.0.1:${upstreamPort}/omnirush/v1`,
    port: 0,
    expectedSecret: "local-secret",
    getToken: () => "access",
  });
  try {
    const result = await request(`${proxy.baseURL}/models`, { secret: "local-secret" });
    assert.equal(result.status, 200);
  } finally {
    setClientVersion("");
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("proxy explains an outdated client version as a non-retryable update error", async () => {
  setClientVersion("1.0.0");
  const upstream = http.createServer((_req, res) => {
    res.writeHead(426, {
      "content-type": "application/json",
      "x-omnirush-update-required": "2.6.9; deadline=2026-10-24T00:00:00.000Z",
    });
    res.end(JSON.stringify({
      error: {
        type: "update_required",
        code: "update_required",
        message: "version 1.0.0 is no longer supported",
      },
    }));
  });
  const upstreamPort = await listen(upstream);
  const proxy = await startTokenProxy({
    gatewayUrl: `http://127.0.0.1:${upstreamPort}/omnirush/v1`,
    port: 0,
    expectedSecret: "local-secret",
    getToken: () => "access",
  });
  try {
    const result = await request(`${proxy.baseURL}/responses`, { secret: "local-secret" });
    const payload = JSON.parse(result.body);
    assert.equal(result.status, 403);
    assert.equal(result.headers["x-should-retry"], "false");
    assert.equal(payload.error.code, "update_required");
    assert.match(payload.error.message, /2\.6\.9/);
    assert.match(payload.error.message, /OMNIRUSH_CLIENT_VERSION/);
    assert.equal(payload.error.omnirush.minimum, "2.6.9");
  } finally {
    setClientVersion("");
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
