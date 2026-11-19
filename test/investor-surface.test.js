// nuvc-mcp 2.0 contract (#5592 / #5710 R15): investor-only tool surface, mandate bound to the
// firm ACCOUNT (not a session), no founder tool under any env, a REPYH founder key refused (#6736).
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, getTools, createHandlers, isFounderKey, isValidApiKey } from "../lib/tools.js";
import { stubApi, INVESTOR_TOOL_NAMES } from "./helpers.js";
import * as F from "./fixtures.js";

const FIRM1_A = "nuvc_test_key_firm1_a";
const FIRM1_B = "nuvc_test_key_firm1_b"; // second key, SAME firm account
const FIRM2 = "nuvc_test_key_firm2";
const ACCOUNT = { [FIRM1_A]: "firm1", [FIRM1_B]: "firm1", [FIRM2]: "firm2" };

/** Fake API with an account-level mandate store (like deal_mandate_service, keyed by owning account). */
function accountApi({ persisted = true } = {}) {
  const store = new Map();
  return stubApi((call) => {
    const acct = ACCOUNT[call.key];
    if (call.path === "/ai/mandate" && call.method === "POST") {
      if (persisted) store.set(acct, call.body);
      return { success: true, data: { mandate: call.body, persisted } };
    }
    if (call.path === "/ai/mandate" && call.method === "GET") {
      return { success: true, data: { mandate: store.get(acct) ?? null } };
    }
    if (call.path === "/ai/score") return F.SCORE;
    return { status: 404, body: { error: { message: "nope" } } };
  });
}

test("default tool list is exactly the investor surface", () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), INVESTOR_TOOL_NAMES);
  assert.deepEqual(getTools().map((t) => t.name).sort(), INVESTOR_TOOL_NAMES);
});

// The name of the removed 1.x switch, assembled so no source line still carries it.
const REMOVED_SWITCH = ["NUVC_MCP", "LEGACY", "FOUNDER", "TOOLS"].join("_");

test("no founder tool is advertised, even with the removed 1.x switch set in the env", () => {
  process.env[REMOVED_SWITCH] = "1";
  try {
    const names = getTools().map((t) => t.name);
    assert.ok(!names.includes("nuvc_roast"));
    assert.ok(names.every((n) => !/roast|repyh/.test(n)), `unexpected founder tool in ${names}`);
    assert.deepEqual([...names].sort(), INVESTOR_TOOL_NAMES);
  } finally {
    delete process.env[REMOVED_SWITCH];
  }
});

test("calling nuvc_roast fails with a migration message naming repyh-mcp and makes no upstream call", async () => {
  const api = accountApi();
  try {
    await assert.rejects(createHandlers(FIRM1_A).nuvc_roast({ text: "x" }), /removed from nuvc-mcp 2\.0.*repyh-mcp.*not released yet.*nuvc-mcp@1\.4\.1/s);
    assert.equal(api.calls.length, 0);
  } finally {
    api.restore();
  }
});

test("mandate is per-account: shared by a firm's keys and fresh sessions, invisible to other firms", async () => {
  const api = accountApi();
  try {
    await createHandlers(FIRM1_A).nuvc_set_mandate({ sectors: ["FinTech"], thesis: "firm one thesis" });
    // A brand-new handler context (new session / new client) on a different key of the SAME firm sees it.
    assert.match(await createHandlers(FIRM1_B).nuvc_get_mandate({}), /firm one thesis/);
    // A different firm does not.
    assert.match(await createHandlers(FIRM2).nuvc_get_mandate({}), /No mandate saved/);
    // Every mandate call carried the calling key; scoring injects no client-side mandate.
    await createHandlers(FIRM1_B).nuvc_score({ text: "a fintech" });
    const score = api.calls.find((c) => c.path === "/ai/score");
    assert.equal(score.body.mandate, undefined);
    assert.equal(score.key, FIRM1_B);
  } finally {
    api.restore();
  }
});

test("set_mandate fails loudly when the account store did not persist (no session-only fallback)", async () => {
  const api = accountApi({ persisted: false });
  try {
    const h = createHandlers(FIRM1_A);
    await assert.rejects(h.nuvc_set_mandate({ sectors: ["FinTech"] }), /NOT applied/);
    await h.nuvc_score({ text: "a fintech" });
    assert.equal(api.calls.find((c) => c.path === "/ai/score").body.mandate, undefined);
  } finally {
    api.restore();
  }
});

test("get_mandate surfaces API errors instead of reporting 'no mandate'", async () => {
  const api = stubApi(() => ({ status: 401, body: { error: { message: "bad key" } } }));
  try {
    await assert.rejects(createHandlers(FIRM1_A).nuvc_get_mandate({}), /Auth error/);
  } finally {
    api.restore();
  }
});

test("a REPYH founder key (repyh_...) is refused before any fetch, on every tool, with a pointer to repyh-mcp", async () => {
  assert.equal(isFounderKey("repyh_" + "a".repeat(64)), true);
  assert.equal(isFounderKey(FIRM1_A), false);
  assert.equal(isValidApiKey("repyh_" + "a".repeat(64)), false);
  const api = accountApi();
  try {
    const h = createHandlers("repyh_" + "a".repeat(64));
    for (const [tool, args] of [["nuvc_score", { text: "a fintech" }], ["nuvc_get_mandate", {}], ["nuvc_models", {}]]) {
      await assert.rejects(h[tool](args), /REPYH founder key.*repyh-mcp.*not released yet.*nuvc-mcp@1\.4\.1/s, tool);
    }
    // stdio passes a getter over the env var; same refusal
    await assert.rejects(createHandlers(() => "repyh_" + "b".repeat(64)).nuvc_models({}), /repyh-mcp/);
    assert.equal(api.calls.length, 0, "a founder key must never reach the network");
  } finally {
    api.restore();
  }
});

test("an investor nuvc_ key still works (keys minted before audiences are nuvc_ and unchanged)", async () => {
  const api = accountApi();
  try {
    await createHandlers(FIRM1_A).nuvc_get_mandate({});
    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].key, FIRM1_A);
  } finally {
    api.restore();
  }
});

test("a key with an embedded newline is refused before any fetch and is never echoed", async () => {
  const bad = "nuvc_abc123\nX-Injected: 1";
  assert.equal(isValidApiKey(bad), false);
  assert.equal(isValidApiKey(" nuvc_abc123 "), true); // surrounding whitespace is trimmed, not echoed or sent
  const api = accountApi();
  try {
    await assert.rejects(createHandlers(bad).nuvc_models({}), (e) => !e.message.includes("abc123") && !e.message.includes("X-Injected"));
    await assert.rejects(createHandlers(() => bad).nuvc_models({}), /NUVC_API_KEY not set or invalid/);
    assert.equal(api.calls.length, 0);
  } finally {
    api.restore();
  }
});
