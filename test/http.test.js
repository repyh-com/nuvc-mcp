// Security regression tests for the HTTP transport + tool state (pre-existing in <=1.4.1):
//  1. /mcp must use the CALLER's own API key — never a shared env key — and 401 without one.
//  2. The mandate belongs to the firm account behind the key — never to the process or session.
//  3. Body cap (413), bad JSON (400 JSON-RPC parse error), no uncaught exceptions.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHttpServer, MAX_BODY_BYTES } from "../server.js";
import { createHandlers } from "../lib/tools.js";
import { stubApi, KEY_A, KEY_B } from "./helpers.js";
import * as F from "./fixtures.js";
import { INVESTOR_TOOL_NAMES } from "./helpers.js";

let server;
let base;
const SHARED_ENV_KEY = "nuvc_shared_server_env_key";
const prevEnv = process.env.NUVC_API_KEY;

before(async () => {
  // A shared server key is present in the environment — HTTP mode must IGNORE it.
  process.env.NUVC_API_KEY = SHARED_ENV_KEY;
  server = createHttpServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (prevEnv === undefined) delete process.env.NUVC_API_KEY;
  else process.env.NUVC_API_KEY = prevEnv;
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

/** Per-key fake API: stores a mandate per key (like the real account-level store). */
function fakeApi() {
  const stored = new Map();
  return stubApi((call) => {
    if (call.path === "/ai/mandate" && call.method === "POST") {
      stored.set(call.key, call.body);
      return F.MANDATE_SET;
    }
    if (call.path === "/ai/mandate" && call.method === "GET") {
      return { success: true, data: { mandate: stored.get(call.key) ?? null } };
    }
    if (call.path === "/ai/score") return F.SCORE;
    return { status: 404, body: { error: { message: "nope" } } };
  });
}

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

function callTool(name, args, headers) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
}

async function toolText(res) {
  const raw = await res.text();
  const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
  const msg = JSON.parse(dataLine ? dataLine.slice(5) : raw);
  return msg.result.content[0].text;
}

test("health check does not require a key", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test("missing key -> 401, and the shared env key is NOT used as a fallback", async () => {
  const api = fakeApi();
  try {
    const res = await callTool("nuvc_score", { text: "a fintech for small business" }, {});
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate"), /Bearer/);
    assert.equal((await res.json()).error.code, -32001);
    assert.equal(api.calls.length, 0, "an unauthenticated request must never reach the NUVC API");
  } finally {
    api.restore();
  }
});

test("a malformed key (wrong prefix) -> 401", async () => {
  const res = await callTool("nuvc_models", {}, { Authorization: "Bearer sk-not-a-nuvc-key" });
  assert.equal(res.status, 401);
});

test("each caller's own key is forwarded upstream (Authorization header, X-API-Key)", async () => {
  const api = fakeApi();
  try {
    await toolText(await callTool("nuvc_score", { text: "a fintech for small business" }, { Authorization: `Bearer ${KEY_A}` }));
    await toolText(await callTool("nuvc_score", { text: "a fintech for small business" }, { "X-API-Key": KEY_B }));
    assert.deepEqual(api.calls.map((c) => c.key), [KEY_A, KEY_B]);
    assert.ok(!api.calls.some((c) => c.key === SHARED_ENV_KEY));
  } finally {
    api.restore();
  }
});

test("two callers with different keys and mandates get isolated results over HTTP", async () => {
  const api = fakeApi();
  try {
    const A = { Authorization: `Bearer ${KEY_A}` };
    const B = { Authorization: `Bearer ${KEY_B}` };
    // Interleaved: A and B each set a different mandate...
    await toolText(await callTool("nuvc_set_mandate", { sectors: ["FinTech"], thesis: "alice thesis" }, A));
    await toolText(await callTool("nuvc_set_mandate", { sectors: ["BioTech"], thesis: "bob thesis" }, B));
    // ...then each reads back ONLY their own.
    const [a, b] = await Promise.all([toolText(await callTool("nuvc_get_mandate", {}, A)), toolText(await callTool("nuvc_get_mandate", {}, B))]);
    assert.ok(a.includes("alice thesis") && !a.includes("bob thesis"), a);
    assert.ok(b.includes("bob thesis") && !b.includes("alice thesis"), b);
    // A caller who never set one sees none (no process-wide mandate).
    const c = await toolText(await callTool("nuvc_get_mandate", {}, { Authorization: "Bearer nuvc_test_key_carol" }));
    assert.match(c, /No mandate saved/);
    // Every upstream mandate call carried the key of the caller that made it.
    for (const call of api.calls.filter((x) => x.method === "POST" && x.path === "/ai/mandate")) {
      assert.equal(call.body.thesis, call.key === KEY_A ? "alice thesis" : "bob thesis");
    }
  } finally {
    api.restore();
  }
});

test("handlers hold no mandate state: score never injects one client-side; the account store does", async () => {
  const api = fakeApi();
  try {
    const a = createHandlers(KEY_A);
    const b = createHandlers(KEY_B);
    await a.nuvc_set_mandate({ sectors: ["FinTech"] });
    await a.nuvc_score({ text: "a fintech for small business" });
    await b.nuvc_score({ text: "a fintech for small business" });
    const scores = api.calls.filter((c) => c.path === "/ai/score");
    // The API resolves the stored account mandate; the client sends nothing of its own.
    assert.equal(scores[0].body.mandate, undefined);
    assert.equal(scores[1].body.mandate, undefined);
    assert.equal(scores[1].key, KEY_B);
    // B's account has no mandate of its own.
    assert.match(await b.nuvc_get_mandate({}), /No mandate saved/);
  } finally {
    api.restore();
  }
});

test("a handler with no key throws instead of falling back to process.env", async () => {
  const api = fakeApi();
  try {
    await assert.rejects(createHandlers(undefined).nuvc_models({}), /NUVC_API_KEY not set or invalid/);
    assert.equal(api.calls.length, 0);
  } finally {
    api.restore();
  }
});

function postRaw(headers, writeBody) {
  // Raw http.request: tolerates the server closing the socket right after it answers 413.
  return new Promise((resolve) => {
    const req = http.request(`${base}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${KEY_A}`, ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", () => resolve("socket-error"));
    writeBody(req);
  });
}

test("oversized body (declared Content-Length) -> 413", async () => {
  // Declare an over-limit length and send NO body: the server must reject on the header alone,
  // without reading (or buffering) a single byte.
  const status = await postRaw({ "Content-Length": MAX_BODY_BYTES + 1 }, (req) => {
    req.flushHeaders();
    req.on("response", () => req.destroy());
  });
  assert.equal(status, 413);
});

test("oversized body streamed without Content-Length -> 413", async () => {
  const status = await postRaw({ "Transfer-Encoding": "chunked" }, (req) => {
    const chunk = Buffer.alloc(256 * 1024, "x");
    for (let i = 0; i < 6; i++) req.write(chunk);
    req.end();
  });
  assert.equal(status, 413);
});

test("invalid JSON -> 400 JSON-RPC parse error (not a crash)", async () => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${KEY_A}` },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.error.code, -32700);
  // and the server is still alive afterwards
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test("non-POST /mcp with a key -> 405; unknown path -> 404", async () => {
  const get = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${KEY_A}` } });
  assert.equal(get.status, 405);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test("tools/list over HTTP is the investor surface; nuvc_roast is not advertised", async () => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${KEY_A}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const raw = await res.text();
  const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
  const names = JSON.parse(dataLine ? dataLine.slice(5) : raw).result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, INVESTOR_TOOL_NAMES);
});

test("calling nuvc_roast over HTTP returns a migration error naming repyh-mcp, not 'Unknown tool'", async () => {
  const api = fakeApi();
  try {
    const out = await toolText(await callTool("nuvc_roast", { text: "x" }, { Authorization: `Bearer ${KEY_A}` }));
    assert.match(out, /removed from nuvc-mcp 2\.0.*repyh-mcp.*founder workflows.*nuvc-mcp@1\.4\.1/s);
    assert.equal(api.calls.length, 0, "no upstream call, no credit");
  } finally {
    api.restore();
  }
});

test("HTTP: a repyh_ founder key gets 401 naming repyh-mcp on a tools/call that would hit the API, with zero fetches", async () => {
  const api = fakeApi();
  try {
    for (const headers of [{ Authorization: `Bearer repyh_${"d".repeat(64)}` }, { "X-API-Key": `repyh_${"d".repeat(64)}` }]) {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nuvc_models", arguments: {} } }),
      });
      assert.equal(res.status, 401);
      assert.match((await res.json()).error.message, /REPYH founder key.*repyh-mcp.*founder workflows.*nuvc-mcp@1\.4\.1/s);
    }
    assert.equal(api.calls.length, 0);
  } finally {
    api.restore();
  }
});
