// Persona toolsets: what each kind of investor is shown, how `auto` picks it, and what never changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHttpServer, createMcpServer, requestedToolset } from "../server.js";
import { TOOLS, createHandlers, createApiCall } from "../lib/tools.js";
import { keyBucket } from "../lib/http-guards.js";
import { UNTRUSTED_NOTICE } from "../lib/own-data.js";
import {
  DEFAULT_TOOLSET, TOOLSET_NAMES, ACCEPTED_TOOLSETS, toolsFor, toolsetForInvestorType, parseToolset, toolsetFromEnv,
  lookupInvestorType, createToolsetCache, createToolsetSelector, toolsetLogLine, inToolset,
} from "../lib/toolsets.js";
import { stubApi, KEY_A, KEY_B, INVESTOR_TOOL_NAMES } from "./helpers.js";

// The advertised tools per toolset, in display order. Written out here on purpose: a change is a contract change.
const EXPECTED = {
  angel: ["nuvc_billing", "nuvc_my_deals", "nuvc_deal_brief", "nuvc_precedent", "nuvc_score", "nuvc_venture_math", "nuvc_match_investors", "nuvc_set_mandate", "nuvc_get_mandate"],
  vc: ["nuvc_billing", "nuvc_my_deals", "nuvc_deal_brief", "nuvc_precedent", "nuvc_extract", "nuvc_score", "nuvc_venture_math", "nuvc_match_investors", "nuvc_set_mandate", "nuvc_get_mandate", "nuvc_fund_economics"],
  allocator: ["nuvc_billing", "nuvc_screen_fund", "nuvc_fund_economics", "nuvc_score", "nuvc_venture_math", "nuvc_extract", "nuvc_analyze"],
  integrator: ["nuvc_billing", "nuvc_models", "nuvc_score", "nuvc_extract", "nuvc_analyze", "nuvc_match_investors", "nuvc_screen_fund", "nuvc_venture_math", "nuvc_fund_economics"],
};

const names = (tools) => tools.map((t) => t.name);
const byName = (tools, n) => tools.find((t) => t.name === n);

// ---------------------------------------------------------------------------
// The sets
// ---------------------------------------------------------------------------

test("each toolset advertises exactly its tools, in order", () => {
  for (const [set, expected] of Object.entries(EXPECTED)) {
    assert.deepEqual(names(toolsFor(set, TOOLS)), expected, set);
  }
  assert.equal(toolsFor("all", TOOLS), TOOLS, "all is the full list, unchanged");
  assert.deepEqual(names(toolsFor("all", TOOLS)).sort(), INVESTOR_TOOL_NAMES);
});

test("persona wording: the vc set uses the angel wording except where it differs, and the allocator screens funds", () => {
  const angel = toolsFor("angel", TOOLS);
  const vc = toolsFor("vc", TOOLS);
  for (const n of ["nuvc_my_deals", "nuvc_deal_brief", "nuvc_precedent", "nuvc_venture_math", "nuvc_set_mandate", "nuvc_get_mandate"]) {
    assert.equal(byName(vc, n).description, byName(angel, n).description, n);
  }
  for (const n of ["nuvc_score", "nuvc_match_investors"]) {
    assert.notEqual(byName(vc, n).description, byName(angel, n).description, n);
  }
  assert.match(byName(angel, "nuvc_score").description, /^Score a pitch 0 to 10 across 5 areas, with a confidence level\. If a mandate is saved, it is checked against it\. 1 credit\. Example: "Score this pitch against my saved mandate: \[paste\]"$/);
  assert.match(byName(vc, "nuvc_score").description, /^Score an inbound pitch 0 to 10 across 5 areas, with a confidence level, and check it against your fund's saved mandate\. 1 credit\. Example: "Screen this deck against our mandate: \[paste\]"$/);
  assert.match(byName(toolsFor("allocator", TOOLS), "nuvc_score").description, /checked against a mandate you pass in/);
  assert.match(byName(toolsFor("integrator", TOOLS), "nuvc_score").description, /Example: "Score this pitch text and return the result as JSON I can show in my platform\."$/);
});

test("every description ends with one example prompt and stays short", () => {
  for (const set of Object.keys(EXPECTED)) {
    for (const t of toolsFor(set, TOOLS)) {
      assert.match(t.description, / Example: "[^"]+"$/, `${set}/${t.name}`);
      assert.ok(t.description.length <= 330, `${set}/${t.name} is ${t.description.length} characters`);
    }
  }
});

test("confidence is claimed only where a handler renders it", () => {
  // nuvc_score and nuvc_screen_fund print a confidence level; nuvc_deal_brief forwards the brief's confidence label.
  // No other tool's description may promise one.
  const withConfidence = new Set(["nuvc_score", "nuvc_screen_fund", "nuvc_deal_brief"]);
  for (const set of Object.keys(EXPECTED)) {
    for (const t of toolsFor(set, TOOLS)) {
      if (!withConfidence.has(t.name)) assert.doesNotMatch(t.description, /confidence/i, `${set}/${t.name}`);
    }
  }
  const screen = byName(toolsFor("allocator", TOOLS), "nuvc_screen_fund").description;
  assert.doesNotMatch(screen, /conviction line/i);
  assert.match(screen, /a confidence level, a one-line verdict/);
});

test("names, input schemas and annotations never change with the toolset: same objects as `all`", () => {
  const all = new Map(TOOLS.map((t) => [t.name, t]));
  for (const set of Object.keys(EXPECTED)) {
    for (const t of toolsFor(set, TOOLS)) {
      const base = all.get(t.name);
      assert.ok(base, `${set}/${t.name} exists in all`);
      assert.equal(t.inputSchema, base.inputSchema, `${set}/${t.name} inputSchema`);
      assert.equal(t.annotations, base.annotations, `${set}/${t.name} annotations`);
    }
  }
});

test("every toolset's tools have handlers; nuvc_roast is advertised nowhere and still answers with the migration message", async () => {
  const handlers = createHandlers(KEY_A);
  for (const set of Object.keys(EXPECTED)) {
    for (const n of EXPECTED[set]) assert.equal(typeof handlers[n], "function", `${set}/${n}`);
    assert.ok(!names(toolsFor(set, TOOLS)).includes("nuvc_roast"));
  }
  assert.ok(!names(TOOLS).includes("nuvc_roast"));
  await assert.rejects(() => handlers.nuvc_roast({}), /removed from nuvc-mcp 2\.0.*repyh-mcp/s);
});

test("integrator and allocator sets carry no workspace tools; allocator carries no mandate tools", () => {
  for (const set of ["integrator", "allocator"]) {
    for (const n of ["nuvc_my_deals", "nuvc_deal_brief", "nuvc_precedent"]) assert.ok(!EXPECTED[set].includes(n), `${set}/${n}`);
  }
  for (const set of ["integrator", "allocator"]) {
    for (const n of ["nuvc_set_mandate", "nuvc_get_mandate"]) assert.ok(!EXPECTED[set].includes(n), `${set}/${n}`);
  }
  assert.deepEqual(TOOLSET_NAMES, ["angel", "vc", "allocator", "integrator", "all"]);
  assert.deepEqual(ACCEPTED_TOOLSETS, [...TOOLSET_NAMES, "auto"]);
});

test("the default is one exported constant", () => {
  assert.equal(DEFAULT_TOOLSET, "auto");
  assert.equal(toolsetFromEnv({}), DEFAULT_TOOLSET);
});

// ---------------------------------------------------------------------------
// The setting
// ---------------------------------------------------------------------------

test("NUVC_TOOLSET: every name is accepted (case and spaces ignored); an unknown value warns once and uses the default", () => {
  for (const n of ACCEPTED_TOOLSETS) assert.equal(toolsetFromEnv({ NUVC_TOOLSET: n }), n);
  assert.equal(toolsetFromEnv({ NUVC_TOOLSET: "  VC " }), "vc");
  assert.equal(toolsetFromEnv({ NUVC_TOOLSET: "" }), DEFAULT_TOOLSET);
  const warnings = [];
  assert.equal(toolsetFromEnv({ NUVC_TOOLSET: "partner-secret-value" }, (l) => warnings.push(l)), DEFAULT_TOOLSET);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not recognised/);
  assert.ok(!warnings[0].includes("partner-secret-value"), "the value is not echoed");
  assert.equal(parseToolset("nope"), undefined);
  assert.equal(parseToolset(undefined), undefined);
});

// ---------------------------------------------------------------------------
// auto
// ---------------------------------------------------------------------------

const TYPE_TO_SET = [
  ["angel", "angel"], ["angel_syndicate", "angel"], ["syndicate", "angel"],
  ["vc", "vc"], ["venture_capital", "vc"], ["corporate_vc", "vc"], ["growth_equity", "vc"],
  ["family_office", "allocator"], ["fund_of_funds", "allocator"],
  // anything else resolves to all
  ["private_equity", "all"], ["accelerator", "all"], ["other", "all"], ["unheard_of", "all"],
  ["", "all"], [null, "all"], [undefined, "all"], [42, "all"],
];

test("auto maps each investor type to its toolset (table-driven)", () => {
  for (const [type, expected] of TYPE_TO_SET) assert.equal(toolsetForInvestorType(type), expected, String(type));
  assert.equal(toolsetForInvestorType(" Family_Office "), "allocator", "case and spaces ignored");
});

const profile = (extra) => ({ success: true, data: { id: "p1", firmName: "Acme Capital", email: "gp@acme.test", ...extra }, message: "Investor profile retrieved" });

const LOOKUP_CASES = [
  ["camelCase type", { body: profile({ investorType: "family_office" }) }, "allocator"],
  ["snake_case type", { body: { success: true, data: { investor_type: "angel" } } }, "angel"],
  ["a vc", { body: profile({ investorType: "vc" }) }, "vc"],
  ["no profile (200, data null)", { body: { success: true, data: null, message: "No investor profile found." } }, "all"],
  ["404", { status: 404, body: { error: { message: "nope" } } }, "all"],
  ["401", { status: 401, body: { detail: "bad key" } }, "all"],
  ["403 (a key that may not call this route)", { status: 403, body: { detail: { code: "FORBIDDEN", message: "x" } } }, "all"],
  ["500", { status: 500, body: { detail: "boom" } }, "all"],
  ["malformed body", { body: "this is not a profile" }, "all"],
  ["array body", { body: [] }, "all"],
  ["null type", { body: profile({ investorType: null }) }, "all"],
  ["missing type", { body: profile({}) }, "all"],
  ["non-string type", { body: profile({ investorType: 7 }) }, "all"],
  ["unmapped type", { body: profile({ investorType: "other" }) }, "all"],
];

test("auto: a failed or empty lookup always resolves to all, and the request is exactly the documented one", async () => {
  for (const [label, reply, expected] of LOOKUP_CASES) {
    const api = stubApi(() => reply);
    try {
      const logs = [];
      const selector = createToolsetSelector({ apiCall: createApiCall(KEY_A), cache: createToolsetCache(), cacheId: "t", log: (l) => logs.push(l) });
      assert.equal(await selector.resolve(), expected, label);
      assert.deepEqual(api.calls, [{ method: "GET", path: "/vc/profiles", key: KEY_A, body: undefined }], label);
      assert.equal(logs.length, 1, label);
    } finally {
      api.restore();
    }
  }
});

test("auto: a network error and a timeout resolve to all and never throw", async () => {
  assert.equal(await lookupInvestorType(async () => { throw new Error("connect ECONNREFUSED"); }), null);
  assert.equal(await lookupInvestorType(async () => { throw Object.assign(new Error("Request timed out after 3s")); }), null);
  assert.equal(await lookupInvestorType(async () => { throw new Error(apiKeyMissing()); }), null);
  // The lookup asks for a 3 second limit.
  let seen;
  await lookupInvestorType(async (m, p, b, opts) => { seen = opts; return { data: { investorType: "vc" } }; });
  assert.deepEqual(seen, { timeoutMs: 3000 });
});
const apiKeyMissing = () => "NUVC_API_KEY not set or invalid.";

test("the call itself gives up at the limit it was given", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  try {
    await assert.rejects(() => createApiCall(KEY_A)("GET", "/vc/profiles", undefined, { timeoutMs: 20 }), /timed out after 0\.02s/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("auto: only the investor type is read, and nothing from the profile is logged", async () => {
  const api = stubApi(() => ({ body: profile({ investorType: "family_office", webhookSecret: "whsec_not_a_real_one", contactPhone: "+61 400 000 000" }) }));
  try {
    const logs = [];
    const selector = createToolsetSelector({ apiCall: createApiCall(KEY_A), cache: createToolsetCache(), cacheId: "t", log: (l) => logs.push(l) });
    await selector.resolve();
    assert.deepEqual(logs, ["nuvc-mcp toolset: allocator (from your account type)"]);
    const text = logs.join("\n");
    for (const leak of [KEY_A, "Acme", "acme.test", "whsec", "400 000", "family_office", "p1"]) assert.ok(!text.includes(leak), `log leaks ${leak}`);
  } finally {
    api.restore();
  }
  assert.equal(await lookupInvestorType(async () => ({ data: { investorType: "vc", email: "x@y.test" } })), "vc");
});

test("the stderr line names the source and carries no key", () => {
  assert.equal(toolsetLogLine("vc", "account"), "nuvc-mcp toolset: vc (from your account type)");
  assert.equal(toolsetLogLine("vc", "setting"), "nuvc-mcp toolset: vc (from NUVC_TOOLSET)");
  assert.equal(toolsetLogLine("all", "untailored"), "nuvc-mcp toolset: all (all tools; no tailored set for your account type)");
  assert.equal(toolsetLogLine("all", "fallback"), "nuvc-mcp toolset: all (default: all tools; account type not available)");
});

test("the stderr line says when the type is known but has no tailored set, and still names nothing from the profile", async () => {
  for (const [reply, line] of [
    [profile({ investorType: "other" }), "nuvc-mcp toolset: all (all tools; no tailored set for your account type)"],
    [profile({ investorType: null }), "nuvc-mcp toolset: all (default: all tools; account type not available)"],
    [profile({ investorType: "venture_capital" }), "nuvc-mcp toolset: vc (from your account type)"],
  ]) {
    const api = stubApi(() => ({ body: reply }));
    try {
      const logs = [];
      const selector = createToolsetSelector({ apiCall: createApiCall(KEY_A), cache: createToolsetCache(), cacheId: "t", log: (l) => logs.push(l) });
      await selector.resolve();
      assert.deepEqual(logs, [line]);
    } finally {
      api.restore();
    }
  }
});

test("the allocator extract wording does not promise fund fields", () => {
  const d = byName(toolsFor("allocator", TOOLS), "nuvc_extract").description;
  assert.equal(d, 'Pull the key figures out of a deck, memo or update letter into fields. Uses your monthly quota. Example: "Extract the key figures from this fund update: [paste]"');
});

test("an explicit setting needs no lookup, and an override beats the setting", async () => {
  const api = stubApi(() => profile({ investorType: "vc" }));
  try {
    const logs = [];
    const selector = createToolsetSelector({ setting: "angel", apiCall: createApiCall(KEY_A), cache: createToolsetCache(), cacheId: "t", log: (l) => logs.push(l), announceSetting: true });
    assert.equal(await selector.resolve(), "angel");
    assert.equal(await selector.resolve(), "angel");
    assert.equal(await selector.resolve("integrator"), "integrator");
    assert.equal(selector.peek(), "angel");
    assert.equal(selector.peek("all"), "all");
    assert.deepEqual(logs, ["nuvc-mcp toolset: angel (from NUVC_TOOLSET)"], "announced once");
    assert.equal(api.calls.length, 0);
  } finally {
    api.restore();
  }
});

test("the cache is bounded, expires, and concurrent first requests share one lookup", async () => {
  let t = 0;
  const cache = createToolsetCache({ ttlMs: 1000, maxEntries: 2, now: () => t });
  cache.set("a", { name: "vc" });
  cache.set("b", { name: "vc" });
  cache.set("c", { name: "vc" });
  assert.equal(cache.size(), 2);
  assert.equal(cache.get("a"), undefined, "least recently used is evicted");
  assert.deepEqual(cache.get("c"), { name: "vc" });
  t = 1001;
  assert.equal(cache.get("c"), undefined, "expired");

  let lookups = 0;
  const apiCall = async () => { lookups += 1; await new Promise((r) => setTimeout(r, 10)); return { data: { investorType: "angel" } }; };
  const selector = createToolsetSelector({ apiCall, cache: createToolsetCache(), cacheId: "k", log: () => {} });
  const got = await Promise.all([selector.resolve(), selector.resolve(), selector.resolve()]);
  assert.deepEqual(got, ["angel", "angel", "angel"]);
  assert.equal(lookups, 1);
});

// ---------------------------------------------------------------------------
// HTTP: once per key within the expiry, the override, the note
// ---------------------------------------------------------------------------

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

async function withServer(env, fn) {
  const logs = [];
  const server = createHttpServer({ env, log: (l) => logs.push(l) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const post = (path, headers, payload) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { ...MCP_HEADERS, ...headers } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, ...payload }));
    });
  const rpc = async (res) => {
    const line = res.text.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : res.text);
  };
  try {
    await fn({ logs, post, rpc });
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

const list = (post, key, path = "/mcp") => post(path, { Authorization: `Bearer ${key}` }, { method: "tools/list" });

test("HTTP auto: one lookup per key within the expiry, the key is not stored, other keys look up separately", async () => {
  const api = stubApi((call) => (call.key === KEY_A ? profile({ investorType: "family_office" }) : profile({ investorType: "vc" })));
  try {
    await withServer({}, async ({ post, rpc, logs }) => {
      const a1 = (await rpc(await list(post, KEY_A))).result.tools.map((t) => t.name);
      const a2 = (await rpc(await list(post, KEY_A))).result.tools.map((t) => t.name);
      assert.deepEqual(a1, EXPECTED.allocator);
      assert.deepEqual(a2, EXPECTED.allocator);
      assert.deepEqual(api.calls.map((c) => [c.method, c.path, c.key]), [["GET", "/vc/profiles", KEY_A]]);
      const b = (await rpc(await list(post, KEY_B))).result.tools.map((t) => t.name);
      assert.deepEqual(b, EXPECTED.vc);
      assert.equal(api.calls.length, 2);
      // one stderr line per lookup, no key in it
      const lines = logs.filter((l) => l.startsWith("nuvc-mcp toolset:"));
      assert.deepEqual(lines, ["nuvc-mcp toolset: allocator (from your account type)", "nuvc-mcp toolset: vc (from your account type)"]);
      assert.ok(!logs.join("\n").includes("nuvc_test_key"));
    });
  } finally {
    api.restore();
  }
});

test("the cache id is a hash of the key, never the key", async () => {
  const api = stubApi(() => profile({ investorType: "vc" }));
  try {
    const seen = [];
    const spy = createToolsetCache();
    const realGet = spy.get;
    spy.get = (id) => { seen.push(id); return realGet(id); };
    const server = createMcpServer(KEY_A, { setting: "auto", cache: spy, log: () => {} });
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), EXPECTED.vc);
    assert.deepEqual(seen, [keyBucket(KEY_A)]);
    assert.notEqual(seen[0], KEY_A);
    await client.close();
  } finally {
    api.restore();
  }
});

test("HTTP: a failed lookup lists every tool", async () => {
  const api = stubApi(() => ({ status: 403, body: { detail: { code: "FORBIDDEN" } } }));
  try {
    await withServer({}, async ({ post, rpc }) => {
      const tools = (await rpc(await list(post, KEY_A))).result.tools.map((t) => t.name);
      assert.deepEqual(tools.sort(), INVESTOR_TOOL_NAMES);
    });
  } finally {
    api.restore();
  }
});

test("HTTP: ?toolset= overrides the process setting for that request and needs no lookup; an unknown name is a 400", async () => {
  const api = stubApi(() => profile({ investorType: "vc" }));
  try {
    await withServer({ NUVC_TOOLSET: "angel" }, async ({ post, rpc }) => {
      assert.deepEqual((await rpc(await list(post, KEY_A))).result.tools.map((t) => t.name), EXPECTED.angel);
      assert.deepEqual((await rpc(await list(post, KEY_A, "/mcp?toolset=integrator"))).result.tools.map((t) => t.name), EXPECTED.integrator);
      assert.deepEqual((await rpc(await list(post, KEY_A, "/mcp?toolset=ALL"))).result.tools.map((t) => t.name).sort(), INVESTOR_TOOL_NAMES);
      const bad = await list(post, KEY_A, "/mcp?toolset=everything");
      assert.equal(bad.status, 400);
      assert.match((await rpc(bad)).error.message, /Unknown toolset\. Use one of: angel, vc, allocator, integrator, all, auto\./);
      assert.equal(api.calls.length, 0, "no lookup when the toolset is named");
      // ?toolset=auto asks for the account's own
      assert.deepEqual((await rpc(await list(post, KEY_A, "/mcp?toolset=auto"))).result.tools.map((t) => t.name), EXPECTED.vc);
      assert.equal(api.calls.length, 1);
    });
  } finally {
    api.restore();
  }
  assert.equal(requestedToolset({ url: "/mcp" }), undefined);
  assert.equal(requestedToolset({ url: "/mcp?toolset=vc" }), "vc");
  assert.equal(requestedToolset({ url: "/mcp?toolset=x" }), null);
});

test("an unknown toolset on an unauthenticated request is still a 401, before anything else", async () => {
  await withServer({}, async ({ post }) => {
    const res = await post("/mcp?toolset=nope", {}, { method: "tools/list" });
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// A tool outside the active toolset stays callable by name
// ---------------------------------------------------------------------------

async function connect(key, toolsets) {
  const server = createMcpServer(key, { log: () => {}, ...toolsets });
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

const SCREEN_OK = { success: true, data: { fund_name: "Fund IV", screening_score: 7.4, confidence: "medium", verdict: "Worth a closer look." } };

test("a tool outside the toolset still runs; the result ends with one line on how to see every tool, after the data notice", async () => {
  const api = stubApi((call) => (call.path === "/ai/screen-fund" ? SCREEN_OK : { status: 404, body: {} }));
  try {
    const client = await connect(KEY_A, { setting: "angel" });
    assert.ok(!(await client.listTools()).tools.some((t) => t.name === "nuvc_screen_fund"));
    const res = await client.callTool({ name: "nuvc_screen_fund", arguments: { fund_name: "Fund IV" } });
    assert.ok(!res.isError);
    const text = res.content[0].text;
    assert.ok(text.startsWith(UNTRUSTED_NOTICE), "the data notice stays first");
    assert.match(text, /Fund IV/);
    assert.match(text, /\n\nNote: nuvc_screen_fund is not in your active toolset \(angel\), so it is not listed, but it ran\. Add \?toolset=all to the server address, or set NUVC_TOOLSET=all on the server, to list every tool\.$/);
    assert.equal(text.match(/Note: nuvc_screen_fund/g).length, 1);
    await client.close();
  } finally {
    api.restore();
  }
});

test("a tool inside the toolset gets no note; an unknown tool keeps today's error; an unresolved auto adds no note and no lookup", async () => {
  const api = stubApi((call) => (call.path === "/ai/mandate" ? { success: true, data: { mandate: null } } : call.path === "/ai/screen-fund" ? SCREEN_OK : { status: 404, body: {} }));
  try {
    const angel = await connect(KEY_A, { setting: "angel" });
    const inSet = await angel.callTool({ name: "nuvc_get_mandate", arguments: {} });
    assert.doesNotMatch(inSet.content[0].text, /not in your active toolset/);
    const unknown = await angel.callTool({ name: "nuvc_nope", arguments: {} });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.content[0].text, "Unknown tool: nuvc_nope");
    await angel.close();

    const before = api.calls.length;
    const auto = await connect(KEY_B, { setting: "auto", cache: createToolsetCache() });
    const res = await auto.callTool({ name: "nuvc_screen_fund", arguments: { fund_name: "Fund IV" } });
    assert.doesNotMatch(res.content[0].text, /not in your active toolset/);
    assert.deepEqual(api.calls.slice(before).map((c) => c.path), ["/ai/screen-fund"], "a call never triggers the lookup");
    await auto.close();
  } finally {
    api.restore();
  }
  assert.ok(inToolset("all", "nuvc_score") && inToolset("vc", "nuvc_score") && !inToolset("angel", "nuvc_screen_fund"));
});

test("once auto is resolved, an out-of-set call carries the note", async () => {
  const api = stubApi((call) => (call.path === "/vc/profiles" ? profile({ investorType: "angel" }) : call.path === "/ai/screen-fund" ? SCREEN_OK : { status: 404, body: {} }));
  try {
    const client = await connect(KEY_A, { setting: "auto", cache: createToolsetCache() });
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), EXPECTED.angel);
    const res = await client.callTool({ name: "nuvc_screen_fund", arguments: { fund_name: "Fund IV" } });
    assert.match(res.content[0].text, /not in your active toolset \(angel\)/);
    await client.close();
  } finally {
    api.restore();
  }
});

// ---------------------------------------------------------------------------
// stdio (a real child process; fetch is stubbed by a preload, so no network)
// ---------------------------------------------------------------------------

async function stdioSession(env, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", new URL("./stub-fetch.js", import.meta.url).pathname, new URL("../index.js", import.meta.url).pathname],
    env: { PATH: process.env.PATH, NUVC_API_KEY: KEY_A, ...env },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (c) => (stderr += c));
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    await fn(client, () => stderr);
  } finally {
    await client.close();
  }
}

test("stdio auto: the account type is read once per process, on the first listing, and printed without the key", async () => {
  await stdioSession({ NUVC_TEST_PROFILE: JSON.stringify(profile({ investorType: "angel_syndicate" })) }, async (client, stderr) => {
    assert.ok(!stderr().includes("STUB-LOOKUP"), "nothing at process start");
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), EXPECTED.angel);
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), EXPECTED.angel);
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), EXPECTED.angel);
    const lookups = stderr().split("\n").filter((l) => l.startsWith("STUB-LOOKUP"));
    assert.deepEqual(lookups, ["STUB-LOOKUP GET /api/v3/vc/profiles body=none"], "one lookup, a GET with no body");
    assert.equal(stderr().split("\n").filter((l) => l.startsWith("nuvc-mcp toolset:")).join("|"), "nuvc-mcp toolset: angel (from your account type)");
    assert.ok(!stderr().includes(KEY_A));
  });
});

test("stdio auto: a refused lookup lists every tool", async () => {
  await stdioSession({ NUVC_TEST_STATUS: "403", NUVC_TEST_PROFILE: JSON.stringify({ detail: { code: "FORBIDDEN" } }) }, async (client, stderr) => {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), INVESTOR_TOOL_NAMES);
    assert.match(stderr(), /nuvc-mcp toolset: all \(default: all tools; account type not available\)/);
  });
});

test("stdio: with no key the listing still works (all tools) and no request is made", async () => {
  await stdioSession({ NUVC_API_KEY: "" }, async (client, stderr) => {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), INVESTOR_TOOL_NAMES);
    assert.ok(!stderr().includes("STUB-LOOKUP"));
  });
});

test("stdio: NUVC_TOOLSET names the set, with no lookup; an unrecognised value warns once and falls back to auto", async () => {
  await stdioSession({ NUVC_TOOLSET: "integrator" }, async (client, stderr) => {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), EXPECTED.integrator);
    await client.listTools();
    assert.ok(!stderr().includes("STUB-LOOKUP"));
    assert.equal(stderr().split("\n").filter((l) => l.startsWith("nuvc-mcp toolset:")).join("|"), "nuvc-mcp toolset: integrator (from NUVC_TOOLSET)");
  });
  await stdioSession({ NUVC_TOOLSET: "banana", NUVC_TEST_PROFILE: JSON.stringify(profile({ investorType: "vc" })) }, async (client, stderr) => {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), EXPECTED.vc);
    assert.equal(stderr().split("\n").filter((l) => /not recognised/.test(l)).length, 1);
    assert.ok(!stderr().includes("banana"));
  });
});

test("stdio: a tool outside the set runs and says how to see every tool", async () => {
  await stdioSession({ NUVC_TOOLSET: "angel" }, async (client) => {
    const res = await client.callTool({ name: "nuvc_models", arguments: {} });
    // the stubbed API answers 404, so the call itself fails; the point is that it was attempted, not "Unknown tool"
    assert.equal(res.isError, true);
    assert.doesNotMatch(res.content[0].text, /Unknown tool/);
    const unknown = await client.callTool({ name: "nuvc_nope", arguments: {} });
    assert.equal(unknown.content[0].text, "Unknown tool: nuvc_nope");
  });
});
