// Error bodies in both shapes: plain `{detail}` (/api/v3/ai/*, not rewritten) and the shape the response
// middleware gives every other route: `{success: false, error: <original body>, message: "Request failed"}`,
// keys camelCased. One helper reads both; the tools say the right thing for each.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandlers, errorInfo } from "../lib/tools.js";
import { NO_ACCESS, NOT_ENABLED, FAMILY_OFFICE_REFUSAL, RATE_LIMITED } from "../lib/workspace-tools.js";
import { stubApi, KEY_A } from "./helpers.js";

/** What the middleware does to a 4xx/5xx body that has no `success` or `error` key. */
const wrapped = (original) => ({ success: false, error: original, message: "Request failed" });

const CASES = [
  ["401 expired", { detail: "API key has expired" }, { code: undefined, message: "API key has expired", list: [] }],
  ["403 FORBIDDEN", { detail: { code: "FORBIDDEN", message: "API key lacks required scope", requiredScope: ["mcp:investor:read"] } }, { code: "FORBIDDEN", message: "API key lacks required scope", list: [] }],
  ["404", { detail: "Not found" }, { code: undefined, message: "Not found", list: [] }],
  ["422 list", { detail: [{ loc: ["body", "text"], msg: "Field required", type: "missing" }, { loc: ["query", "limit"], msg: "Input should be 1", type: "x" }] }, { code: undefined, message: "", list: ["text: Field required", "limit: Input should be 1"] }],
  ["429 quota", { detail: { code: "QUOTA_EXCEEDED", message: "Monthly quota used." } }, { code: "QUOTA_EXCEEDED", message: "Monthly quota used.", list: [] }],
  ["500", { detail: "Internal server error" }, { code: undefined, message: "Internal server error", list: [] }],
  ["503", { detail: "Service unavailable" }, { code: undefined, message: "Service unavailable", list: [] }],
  ["family office refusal", { detail: { error: "product_scope_mismatch", message: "This endpoint is part of the VC product, not Family Office." } }, { code: "product_scope_mismatch", message: "This endpoint is part of the VC product, not Family Office.", list: [] }],
];

test("errorInfo reads the plain and the wrapped shape alike", () => {
  for (const [label, plain, expected] of CASES) {
    assert.deepEqual(errorInfo(plain), expected, `${label} plain`);
    assert.deepEqual(errorInfo(wrapped(plain)), expected, `${label} wrapped`);
    // the middleware camelCases the keys inside; snake_case keys read the same
    const camelled = JSON.parse(JSON.stringify(wrapped(plain)).replace(/"required_scope"/g, '"requiredScope"'));
    assert.deepEqual(errorInfo(camelled), expected, `${label} camelCase`);
  }
  // the platform's own shapes
  assert.deepEqual(errorInfo({ success: false, error: { code: "X_CODE", message: "Plain error." } }), { code: "X_CODE", message: "Plain error.", list: [] });
  assert.deepEqual(errorInfo({ success: false, error: "Not found" }), { code: undefined, message: "Not found", list: [] });
  assert.deepEqual(errorInfo({ error: "insufficient_credits", message: "No credits." }), { code: "insufficient_credits", message: "No credits.", list: [] });
  for (const junk of [null, undefined, "x", 3, [], {}]) assert.deepEqual(errorInfo(junk), { code: undefined, message: "", list: [] });
});

async function failsWith(call, response) {
  const api = stubApi(() => response);
  try {
    return await call(createHandlers(KEY_A)).then(() => assert.fail("expected an error"), (e) => e);
  } finally {
    api.restore();
  }
}

const SHAPES = [["plain", (b) => b], ["wrapped", wrapped]];

test("a pipeline tool reads every status in both shapes", async () => {
  for (const [shape, wrap] of SHAPES) {
    const run = (status, original) => failsWith((h) => h.nuvc_my_deals({}), { status, body: wrap(original) });
    let e = await run(401, { detail: "API key has expired" });
    assert.match(e.message, /API key has expired/, shape);
    assert.match(e.message, /Keys expire \(30 days by default\); create a new key at https:\/\/nuvc\.ai\/api-platform\/keys/, shape);
    assert.equal(e.status, 401);
    e = await run(401, { detail: "Invalid API key" });
    assert.match(e.message, /Auth error: Invalid API key/, shape);
    assert.ok(!/expire/.test(e.message), shape);
    e = await run(403, { detail: { code: "FORBIDDEN", message: "API key lacks required scope" } });
    assert.equal(e.message, NO_ACCESS, shape);
    e = await run(404, { detail: "Not found" });
    assert.equal(e.message, NOT_ENABLED, shape);
    e = await run(422, { detail: [{ loc: ["query", "limit"], msg: "Input should be less than or equal to 50", type: "x" }] });
    assert.equal(e.message, "API error (422): limit: Input should be less than or equal to 50", shape);
    e = await run(429, { detail: { code: "QUOTA_EXCEEDED", message: "Your monthly quota is used up." } });
    assert.match(e.message, /monthly quota is used up.*nuvc_billing.*reset date/, shape);
    e = await run(500, { detail: "Internal server error" });
    assert.equal(e.message, "API error (500): Internal server error", shape);
    e = await run(503, { detail: "Service unavailable" });
    assert.equal(e.message, "API error (503): Service unavailable", shape);
  }
});

test("an expired key on a pipeline tool is not reported as missing workspace access (A20)", async () => {
  for (const tool of ["nuvc_my_deals", "nuvc_deal_brief", "nuvc_precedent"]) {
    const e = await failsWith((h) => h[tool]({ deckId: "11111111-1111-4111-8111-111111111111", deck_id: "11111111-1111-4111-8111-111111111111" }), { status: 401, body: wrapped({ detail: "API key has expired" }) });
    assert.notEqual(e.message, NO_ACCESS, tool);
    assert.match(e.message, /expire/, tool);
  }
});

test("a per-route rate limit says wait and retry, with no pack to buy; a spent quota keeps its own message (A26)", async () => {
  for (const [, wrap] of SHAPES) {
    const e = await failsWith((h) => h.nuvc_my_deals({}), { status: 429, body: wrap({ detail: "Rate limit exceeded: 30 per 1 minute" }) });
    assert.equal(e.message, RATE_LIMITED);
    assert.ok(!/pack|billing|\$/i.test(e.message));
  }
});

test("a family office account is told why the pipeline tools do not apply; a missing profile gets the API's own message (A26)", async () => {
  const fo = { detail: { error: "product_scope_mismatch", message: "This endpoint is part of the VC product, not Family Office." } };
  const noProfile = { detail: { error: "investor_profile_required", message: "Complete your investor onboarding to access deal screening, pipeline management, and fund intelligence.", actionUrl: "https://example.test/x" } };
  for (const [shape, wrap] of SHAPES) {
    for (const tool of ["nuvc_my_deals", "nuvc_deal_brief", "nuvc_precedent"]) {
      const args = { deck_id: "11111111-1111-4111-8111-111111111111" };
      let e = await failsWith((h) => h[tool](args), { status: 403, body: wrap(fo) });
      assert.equal(e.message, FAMILY_OFFICE_REFUSAL, `${tool} ${shape}`);
      e = await failsWith((h) => h[tool](args), { status: 403, body: wrap(noProfile) });
      assert.equal(e.message, "Complete your investor onboarding to access deal screening, pipeline management, and fund intelligence.", `${tool} ${shape}`);
    }
  }
  assert.equal(FAMILY_OFFICE_REFUSAL, "These pipeline tools read the venture pipeline, which family office accounts do not have. Your fund screening and fund economics tools still work.");
});

test("the shared call reads both shapes on the AI tools too (quota 429, 402, 422 list)", async () => {
  for (const [shape, wrap] of SHAPES) {
    let e = await failsWith((h) => h.nuvc_score({ text: "x".repeat(20) }), { status: 429, body: wrap({ detail: { code: "QUOTA_EXCEEDED", message: "Monthly free quota used." } }) });
    assert.match(e.message, /monthly quota is used up.*nuvc_billing/, shape);
    e = await failsWith((h) => h.nuvc_score({ text: "x".repeat(20) }), { status: 422, body: wrap({ detail: [{ loc: ["body", "text"], msg: "Too short", type: "x" }] }) });
    assert.equal(e.message, "API error (422): text: Too short", shape);
    e = await failsWith((h) => h.nuvc_score({ text: "x".repeat(20) }), { status: 402, body: wrap({ detail: { message: "You have no score credits left." } }) });
    assert.match(e.message, /account access or score credits.*nuvc_billing.*free read/, shape);
  }
});

// --- review fixes ------------------------------------------------------------------------------------------

import { createApiCall } from "../lib/tools.js";
import { toolsetForInvestorType } from "../lib/toolsets.js";
import { cleanText } from "../lib/own-data.js";

test("errorInfo reads one more level of nesting", () => {
  assert.deepEqual(errorInfo({ success: false, error: { error: { detail: { code: "FORBIDDEN", message: "No." } } } }), { code: "FORBIDDEN", message: "No.", list: [] });
  assert.deepEqual(errorInfo({ error: { error: { detail: "Deep" } } }), { code: undefined, message: "Deep", list: [] });
});

test("an empty error body and empty status text still say something", async () => {
  for (const [status, expected] of [[401, /^Auth error: no details were returned\. Check NUVC_API_KEY/], [400, /^API error \(400\): no details were returned$/]]) {
    const api = stubApi(() => ({ status, body: {} }));
    const realFetch = globalThis.fetch;
    const wrap = globalThis.fetch;
    globalThis.fetch = async (u, i) => { const r = await wrap(u, i); return new Response(null, { status: r.status, statusText: "" }); };
    try {
      await assert.rejects(() => createHandlers(KEY_A).nuvc_models({}), (e) => expected.test(e.message));
    } finally {
      globalThis.fetch = realFetch;
      api.restore();
    }
  }
});

test("the timeout covers reading the body, for a success and for an error response", async () => {
  const realFetch = globalThis.fetch;
  const stalled = (ok, status) => ({ ok, status, statusText: "", json: () => new Promise(() => {}) });
  try {
    for (const res of [stalled(true, 200), stalled(false, 500)]) {
      globalThis.fetch = async () => res;
      const started = Date.now();
      await assert.rejects(() => createApiCall(KEY_A)("GET", "/vc/profiles", undefined, { timeoutMs: 30 }), /timed out after 0\.03s/);
      assert.ok(Date.now() - started < 1000);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an investor type that is an Object property name never resolves to anything but all", () => {
  for (const t of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) assert.equal(toolsetForInvestorType(t), "all", t);
});

test("cleanText strips zero-width, bidirectional and tag characters", () => {
  const dirty = "a​b‏c‮d⁦e⁩f﻿g\u{e0041}\u{e007f}h\u0007i";
  assert.equal(cleanText(dirty), "a b c d e f g h i");
});


test("payment and quota recovery never repeats upstream offers or makes a second request", async () => {
  for (const status of [402, 429]) {
    for (const [, wrap] of SHAPES) {
      const api = stubApi(() => ({ status, body: wrap({ detail: { code: status === 429 ? "QUOTA_EXCEEDED" : "insufficient_credits", message: "PRIVATE $999 offer at https://untrusted.example; buy now", topUpUrl: "https://untrusted.example" } }) }));
      try {
        await assert.rejects(() => createHandlers(KEY_A).nuvc_analyze({ text: "A pitch with enough detail for feedback" }), (error) => {
          assert.equal(error.status, status);
          assert.match(error.message, /nuvc_billing.*free read/);
          assert.doesNotMatch(error.message, /PRIVATE|999|untrusted|buy now|Top up/);
          return true;
        });
        assert.equal(api.calls.length, 1, "no automatic billing lookup, checkout or paid retry");
        assert.equal(api.calls[0].path, "/ai/analyze");
        assert.equal(api.calls[0].method, "POST");
      } finally { api.restore(); }
    }
  }
});
