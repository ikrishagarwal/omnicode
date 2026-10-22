import {
  createRefresher,
  gatewayUrlForOrigin,
  loadAuth,
  omniDir,
  originFromGatewayUrl,
  resolveGatewayUrl,
  resolveOrigin,
  storedSessionEnded,
} from "../lib/auth.js";
import { startTokenProxy } from "../lib/proxy.js";
import { loadOrCreateProxyKey, proxyKeyPath } from "../lib/proxy-key.js";

export const DEFAULT_PROXY_HOST = "127.0.0.1";
export const DEFAULT_PROXY_PORT = 8789;

export function proxyHelp() {
  return [
    "Usage: omnicode proxy [--port <port>]",
    "",
    "Start a loopback proxy that injects the current OmniRush access token.",
    "The local API key is reused from <OMNIRUSH_DIR>/proxy-key.",
    "The cloud access and refresh tokens are never printed or given to the local client.",
    "",
    "Options:",
    `  --port <port> listen port (default: ${DEFAULT_PROXY_PORT})`,
    "  -h, --help   show this help",
  ].join("\n");
}

function parsePort(argv, env) {
  let value = env.OMNICODE_PROXY_PORT || env.OMNIRUSH_PROXY_PORT || String(DEFAULT_PROXY_PORT);
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--port") {
      value = argv[++index];
      if (!value) throw new Error("--port requires a value");
    } else if (argv[index].startsWith("--port=")) {
      value = argv[index].slice("--port=".length);
    } else if (argv[index] !== "-h" && argv[index] !== "--help") {
      throw new Error(`unknown proxy option: ${argv[index]}`);
    }
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("proxy port must be an integer from 0 to 65535");
  return port;
}

export async function runProxy({ argv = [], env = process.env, stdout = process.stdout, fetchImpl = globalThis.fetch, startProxy = startTokenProxy } = {}) {
  if (argv.includes("-h") || argv.includes("--help")) {
    stdout.write(`${proxyHelp()}\n`);
    return;
  }
  const dir = omniDir(env);
  const auth = loadAuth(dir);
  if (!auth) throw new Error("not signed in; run `omnicode login` first");
  const ended = storedSessionEnded(dir);
  if (ended) throw new Error(`stored OmniRush session is no longer valid (${ended.detail}); run omnicode login again`);
  const gatewayUrl = resolveGatewayUrl(env, auth.gatewayUrl);
  const origin = originFromGatewayUrl(gatewayUrl) || resolveOrigin(env);
  const refresher = createRefresher({ dir, origin, fetchImpl });
  const secret = loadOrCreateProxyKey(dir);
  const port = parsePort(argv, env);
  let proxy;
  try {
    proxy = await startProxy({
      gatewayUrl: gatewayUrl || gatewayUrlForOrigin(origin),
      getToken: () => refresher.accessToken(),
      refreshToken: async (tokenUsed) => {
        const outcome = await refresher.recover(tokenUsed || refresher.accessToken());
        return outcome.status === "ok" ? outcome.accessToken : "";
      },
      expectedSecret: secret,
      hostname: DEFAULT_PROXY_HOST,
      port,
    });
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      throw new Error(`proxy port ${port} is already in use; use the existing OmniCode proxy, stop it before restarting, or choose another port with --port`);
    }
    throw error;
  }

  stdout.write("OmniCode proxy is running\n");
  stdout.write(`  Base URL: ${proxy.baseURL}\n`);
  stdout.write(`  Local API key: ${proxyKeyPath(dir)}\n`);
  stdout.write("  Press Ctrl-C to stop.\n");

  let closing = false;
  const close = async (signal) => {
    if (closing) return;
    closing = true;
    await proxy.close().catch(() => undefined);
    if (signal) stdout.write(`\nOmniCode proxy stopped (${signal}).\n`);
  };
  const onSignal = (signal) => { void close(signal).finally(() => process.exitCode = 0); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return { proxy, secret, close };
}
