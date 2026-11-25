#!/usr/bin/env node

/**
 * NUVC MCP HTTP Server
 *
 * Exposes the NUVC MCP server over HTTP (Streamable HTTP transport, stateless).
 * Compatible with Smithery, Claude Desktop (remote), and any MCP HTTP client.
 *
 * POST /mcp  — MCP Streamable HTTP endpoint (requires the CALLER's own NUVC API key)
 * GET  /     — Health check
 *
 * Auth (per request, in priority order):
 *   1. Authorization: Bearer nuvc_...
 *   2. X-API-Key: nuvc_...
 *   3. ONLY if NUVC_MCP_ALLOW_CONFIG_QUERY_KEY=1 (default off): Smithery config param
 *      ?config=<base64 JSON with NUVC_API_KEY | nuvcApiKey | apiKey>. URLs are logged; prefer headers.
 *
 * SECURITY (1.4.2): this server NEVER reads a shared key from the environment. Every request
 * is authenticated with, and billed to, the caller's own key; a request without one gets 401.
 * (<=1.4.1 proxied every caller through process.env.NUVC_API_KEY, and kept the investor
 * mandate in module state shared across callers.) Each request builds its own handler context.
 *
 * Hardening (env): MCP_ALLOWED_ORIGINS (comma-separated; a request with an Origin header not listed
 * gets 403, none by default), MCP_RATE_LIMIT_PER_MINUTE (per key, default 60) and
 * MCP_RATE_LIMIT_PER_MINUTE_IP (per address, IPv6 by /64, default 600), 429 + Retry-After, one access-log line per request on stderr (no query string, no key, no body).
 *
 * env: PORT (default 3000)
 */

import http from "node:http";
import { SERVER_INSTRUCTIONS } from "./lib/guidance.js";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { cleanText } from "./lib/own-data.js";
import { originRefused, clientAddress, createLimiters, addressBucket, keyBucket, accessLogLine } from "./lib/http-guards.js";
import { TOOLS, createHandlers, createApiCall, isValidApiKey, isFounderKey, apiKeyProblem } from "./lib/tools.js";
import {
  ACCEPTED_TOOLSETS, parseToolset, toolsFor, toolsetFromEnv,
  createToolsetCache, createToolsetSelector, withOutOfSetNote,
} from "./lib/toolsets.js";

const { version } = createRequire(import.meta.url)("./package.json");

export const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// Build MCP server — one instance (and one tool context) per request
// ---------------------------------------------------------------------------

/**
 * `toolsets` (optional) = { setting, cache, override, log }: the process-wide toolset setting, the shared cache of
 * resolved toolsets (keyed by a hash of the key, never the key), and this request's `?toolset=` override. Without
 * it the full list is advertised.
 */
export function createMcpServer(apiKey, toolsets = {}) {
  const HANDLERS = createHandlers(apiKey);
  const selector = createToolsetSelector({
    setting: toolsets.setting ?? "all",
    apiCall: createApiCall(apiKey),
    cache: toolsets.cache ?? createToolsetCache(),
    cacheId: keyBucket(apiKey),
    log: toolsets.log,
  });
  const override = toolsets.override;
  const server = new Server(
    { name: "nuvc", version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsFor(await selector.resolve(override), TOOLS) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = HANDLERS[name];
    if (!handler) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      const result = await handler(args || {});
      const note = "Add ?toolset=all to the server address, or set NUVC_TOOLSET=all on the server, to list every tool.";
      return { content: [{ type: "text", text: withOutOfSetNote(result, name, selector.peek(override), note) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${cleanText(err.message)}` }], isError: true };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function rpcError(code, message) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

/** The key carried in a Smithery-style `?config=` query parameter (base64 JSON), if any. */
export function configQueryKey(req) {
  try {
    const cfg = new URL(req.url, "http://localhost").searchParams.get("config");
    if (cfg) {
      const parsed = JSON.parse(Buffer.from(cfg, "base64").toString("utf8"));
      const k = parsed?.NUVC_API_KEY || parsed?.nuvcApiKey || parsed?.apiKey;
      if (typeof k === "string" && k.trim()) return k.trim();
    }
  } catch {
    // malformed config - treated as "no key"
  }
  return undefined;
}

/**
 * Extract the caller's own API key from the request. Returns undefined if absent.
 * A key in the URL is logged by proxies and clients, so the `?config=` path is OFF unless
 * NUVC_MCP_ALLOW_CONFIG_QUERY_KEY=1 (kept only for directory-listing gateways that cannot send headers).
 */
export function extractApiKey(req, env = process.env) {
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m) return m[1];
  }
  const xKey = req.headers["x-api-key"];
  if (typeof xKey === "string" && xKey.trim()) return xKey.trim();
  return env.NUVC_MCP_ALLOW_CONFIG_QUERY_KEY === "1" ? configQueryKey(req) : undefined;
}

class BodyTooLargeError extends Error {}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError();
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

/** `?toolset=<name>` on the request: undefined when absent, the validated name, or null when it is not one we accept. */
export function requestedToolset(req) {
  const raw = new URL(req.url, "http://localhost").searchParams.get("toolset");
  if (raw === null) return undefined;
  return parseToolset(raw) ?? null;
}

async function handleMcp(req, res, { env, limiters, toolsets }) {
  // Origin (DNS rebinding) and rate limit BEFORE auth and before the body is read.
  if (originRefused(req, env)) {
    sendJson(res, 403, rpcError(-32000, "Forbidden: origin not allowed"));
    return;
  }
  const tooMany = (verdict) =>
    sendJson(res, 429, rpcError(-32000, "Rate limit exceeded. Retry shortly."), { "Retry-After": String(verdict.retryAfterSeconds) });
  const ipVerdict = limiters.ip.take(addressBucket(clientAddress(req, env)));
  if (!ipVerdict.ok) return tooMany(ipVerdict);

  // Authenticate BEFORE reading the body — an anonymous caller costs us nothing.
  const apiKey = extractApiKey(req, env);
  if (!isValidApiKey(apiKey)) {
    // A key supplied only in the URL is refused with a pointer to the header, not the generic message.
    if (apiKey === undefined && configQueryKey(req)) {
      sendJson(
        res,
        401,
        rpcError(-32001, "Unauthorized: a key in the URL is not accepted. Send your NUVC API key in the 'Authorization: Bearer nuvc_...' header."),
        { "WWW-Authenticate": 'Bearer realm="nuvc-mcp"' }
      );
      return;
    }
    // A REPYH founder key (repyh_...) gets the "use repyh-mcp" message, not the generic one.
    sendJson(
      res,
      401,
      rpcError(
        -32001,
        isFounderKey(apiKey)
          ? `Unauthorized: ${apiKeyProblem(apiKey)}`
          : "Unauthorized: send your NUVC API key as 'Authorization: Bearer nuvc_...'. Get a free key at https://nuvc.ai/api-platform/keys"
      ),
      { "WWW-Authenticate": 'Bearer realm="nuvc-mcp"' }
    );
    return;
  }

  // Per-key cap (shape-valid keys only), still before the body is read.
  const keyVerdict = limiters.key.take(keyBucket(apiKey));
  if (!keyVerdict.ok) return tooMany(keyVerdict);

  if (req.method !== "POST") {
    sendJson(res, 405, rpcError(-32000, "Method not allowed"), { Allow: "POST" });
    return;
  }

  const override = requestedToolset(req);
  if (override === null) {
    sendJson(res, 400, rpcError(-32602, `Unknown toolset. Use one of: ${ACCEPTED_TOOLSETS.join(", ")}.`));
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      // Respond first, then drop the connection (after a short grace period so the client can
      // read the 413 before the socket closes) so it stops uploading.
      res.once("finish", () => setTimeout(() => req.destroy(), 250).unref());
      sendJson(res, 413, rpcError(-32000, `Request body too large (max ${MAX_BODY_BYTES} bytes)`));
      return;
    }
    throw err;
  }

  let parsed;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 400, rpcError(-32700, "Parse error: request body is not valid JSON"));
      return;
    }
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  res.on("close", () => transport.close());

  const server = createMcpServer(apiKey, { ...toolsets, override });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsed);
}

export function createHttpServer({ env = process.env, log = (line) => console.error(line) } = {}) {
  const limiters = createLimiters(env);
  // One resolved toolset per key for about ten minutes, in a bounded map keyed by the key's hash.
  const toolsets = { setting: toolsetFromEnv(env, log), cache: createToolsetCache({ ttlMs: 10 * 60_000, maxEntries: 10_000 }), log };
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const client = clientAddress(req, env);
    const pathname = (req.url || "/").split("?")[0];
    // The health check is not logged (Fly polls it every 30s). 499 = the client left before the response finished.
    if (!(req.method === "GET" && pathname === "/")) {
      res.on("close", () => log(accessLogLine({ name: "nuvc-mcp", req, status: res.writableFinished ? res.statusCode : 499, ms: Date.now() - started, client })));
    }
    try {

      // Health check
      if (req.method === "GET" && pathname === "/") {
        sendJson(res, 200, { ok: true, name: "nuvc-mcp", version });
        return;
      }

      if (pathname === "/mcp") {
        await handleMcp(req, res, { env, limiters, toolsets });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      // Never leak internals (stack traces, paths) to the caller.
      console.error(`nuvc-mcp request failed: ${err?.name || "Error"}: ${err?.message}`);
      sendJson(res, 500, rpcError(-32603, "Internal server error"));
    }
  });
}

process.on("unhandledRejection", (reason) => {
  console.error(`nuvc-mcp unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

// Start only when run directly (`node server.js`), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const PORT = parseInt(process.env.PORT || "3000", 10);
  createHttpServer().listen(PORT, () => {
    console.error(`NUVC MCP server listening on port ${PORT}`);
    console.error(`MCP endpoint: http://localhost:${PORT}/mcp (requires 'Authorization: Bearer nuvc_...')`);
  });
}
