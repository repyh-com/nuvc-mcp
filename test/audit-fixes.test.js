// Tool audit fixes (#6763): readable validation and quota errors, stated input limits, confidence on scores,
// and no blank or null output. Response bodies are shaped like the real routes' bodies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandlers, getTools } from "../lib/tools.js";
import { stubApi, KEY_A } from "./helpers.js";
import * as F from "./fixtures.js";

const h = () => createHandlers(KEY_A);
const prop = (tool, ...path) => path.reduce((o, k) => o?.[k], getTools().find((t) => t.name === tool).inputSchema.properties);

async function failsWith(call, respond) {
  const api = stubApi(respond);
  try {
    await assert.rejects(call, (e) => {
      failsWith.last = e;
      return true;
    });
    return failsWith.last;
  } finally {
    api.restore();
  }
}

// --- 1. error mapping -------------------------------------------------------------------------------

test("a 422 with a FastAPI detail list reads as field: message lines, capped, never [object Object]", async () => {
  const detail = Array.from({ length: 7 }, (_, i) => ({ loc: ["body", i === 0 ? "text" : `f${i}`], msg: i === 0 ? "String should have at least 10 characters" : "bad", type: "x" }));
  const e = await failsWith(() => h().nuvc_score({ text: "short" }), () => ({ status: 422, body: { detail } }));
  assert.match(e.message, /^API error \(422\): text: String should have at least 10 characters; f1: bad/);
  assert.match(e.message, /\(and 2 more\)/);
  assert.ok(!e.message.includes("[object Object]"), e.message);
  assert.equal(e.status, 422);
});

test("a detail object without a message falls back to short JSON, never [object Object]", async () => {
  const e = await failsWith(() => h().nuvc_score({ text: "x".repeat(20) }), () => ({ status: 400, body: { detail: { code: "ODD", extra: 1 } } }));
  assert.match(e.message, /"code":"ODD"/);
  assert.ok(!e.message.includes("[object Object]"), e.message);
});

test("a spent quota points to free billing discovery without promising a credit purchase", async () => {
  const message = "Monthly free quota used. Buy credits to continue.";
  const e = await failsWith(() => h().nuvc_score({ text: "x".repeat(20) }), () => ({ status: 429, body: { detail: { code: "QUOTA_EXCEEDED", message } } }));
  assert.match(e.message, /monthly quota is used up.*nuvc_billing.*reset date/);
  assert.doesNotMatch(e.message, /Buy credits/);
  assert.ok(!/wait/i.test(e.message));
});

test("a plain 429 keeps the wait-and-retry wording", async () => {
  const e = await failsWith(() => h().nuvc_score({ text: "x".repeat(20) }), () => ({ status: 429, body: { detail: "Too many requests" } }));
  assert.match(e.message, /Rate limit reached\. Wait a moment before trying again/);
});

test("a 402 points to free billing discovery without promising a pack or repeating backend copy", async () => {
  const body = { error: "insufficient_credits", message: "You have no score credits left.", top_up_url: "/billing", remaining: 0 };
  const e = await failsWith(() => h().nuvc_score({ text: "x".repeat(20) }), () => ({ status: 402, body }));
  assert.match(e.message, /account access or score credits.*nuvc_billing.*free read/);
  assert.doesNotMatch(e.message, /Top up|always free|You have no score credits/);
  assert.ok(!/\$\d|AUD/.test(e.message), e.message);
});

test("any 401 says a key that used to work may have expired and where to create a new one", async () => {
  // The API answers an unknown, revoked and expired key with the same text, so the hint cannot wait for "expired".
  for (const detail of ["API key has expired", "Authentication required - use Supabase JWT, magic link token, or API key (nuvc_)"]) {
    const e = await failsWith(() => h().nuvc_models({}), () => ({ status: 401, body: { detail } }));
    assert.ok(e.message.includes(detail), e.message);
    assert.match(e.message, /may have expired or been revoked: create a new one at https:\/\/nuvc\.ai\/api-platform\/keys$/);
    assert.equal(e.status, 401);
  }
});

test("a 402 and a spent quota name the billing page, so paying does not depend on another tool call", async () => {
  let e = await failsWith(() => h().nuvc_score({ text: "x".repeat(20) }), () => ({ status: 402, body: { detail: { message: "none left" } } }));
  assert.match(e.message, /https:\/\/nuvc\.ai\/api-platform\/billing/);
  e = await failsWith(() => h().nuvc_score({ text: "x".repeat(20) }), () => ({ status: 429, body: { detail: { code: "QUOTA_EXCEEDED", message: "used" } } }));
  assert.match(e.message, /https:\/\/nuvc\.ai\/api-platform\/billing/);
});

// --- 2. input limits --------------------------------------------------------------------------------

test("tool schemas state the limits the routes enforce", () => {
  for (const t of ["nuvc_score", "nuvc_analyze", "nuvc_extract"]) {
    assert.equal(prop(t, "text", "minLength"), 10, t);
    assert.equal(prop(t, "text", "maxLength"), 500000, t);
  }
  assert.equal(prop("nuvc_match_investors", "text", "minLength"), 20);
  assert.deepEqual([prop("nuvc_match_investors", "limit", "minimum"), prop("nuvc_match_investors", "limit", "maximum")], [1, 10]);
  assert.equal(prop("nuvc_screen_fund", "fund_name", "minLength"), 2);
  assert.deepEqual([prop("nuvc_screen_fund", "vintage_year", "minimum"), prop("nuvc_screen_fund", "vintage_year", "maximum")], [1980, 2035]);
  assert.equal(prop("nuvc_screen_fund", "track_record", "maxLength"), 5000);
  assert.equal(prop("nuvc_screen_fund", "description", "maxLength"), 20000);
  for (const [tool, path] of [["nuvc_set_mandate", []], ["nuvc_score", ["mandate", "properties"]]]) {
    const p = (k, kw) => (path.length ? prop(tool, "mandate", "properties", k, kw) : prop(tool, k, kw));
    assert.equal(p("thesis", "maxLength"), 5000, tool);
    assert.equal(p("anti_thesis", "maxLength"), 5000, tool);
    assert.equal(p("check_size_min", "minimum"), 0, tool);
    assert.equal(p("check_size_max", "minimum"), 0, tool);
  }
});

// --- 3. score confidence ----------------------------------------------------------------------------

test("nuvc_score prints the confidence with the house band", async () => {
  for (const [c, expected] of [[0.62, "Confidence: Medium (0.62)"], [0.85, "Confidence: High (0.85)"], [0.3, "Confidence: Low (0.30)"], [0.1, "Confidence: Uncertain (0.10)"]]) {
    const api = stubApi(() => ({ success: true, data: { ...F.SCORE.data, confidence: c } }));
    try {
      assert.ok((await h().nuvc_score({ text: "x".repeat(20) })).includes(expected), expected);
    } finally {
      api.restore();
    }
  }
});

test("the nuvc_score description promises only what the route returns", () => {
  const d = getTools().find((t) => t.name === "nuvc_score").description;
  assert.ok(!/diligence questions|strengths, gaps/i.test(d), d);
  assert.match(d, /confidence level/);
});

// --- 4. screen-fund with nothing returned -----------------------------------------------------------

test("nuvc_screen_fund says plainly when the response has no score and no decision", async () => {
  const api = stubApi(() => ({ success: true, data: { fund_name: "Fund IV", screening_score: null, decision: null, dimensions: {} } }));
  try {
    const out = await h().nuvc_screen_fund({ fund_name: "Fund IV" });
    assert.match(out, /No result was returned for this fund; try again\./);
    assert.ok(!/charged/i.test(out), "must not promise billing behaviour");
  } finally {
    api.restore();
  }
});

// --- 5. extract with nested values ------------------------------------------------------------------

test("nuvc_extract renders nested objects and arrays as compact JSON, not [object Object]", async () => {
  const api = stubApi(() => ({ success: true, data: { extracted: { company: "Acme", team: [{ name: "Jo", role: "CEO" }], metrics: { arr: 100 }, tags: ["a", "b"], nothing: null } } }));
  try {
    const out = await h().nuvc_extract({ text: "x".repeat(20) });
    assert.ok(!out.includes("[object Object]"), out);
    assert.ok(out.includes('[{"name":"Jo","role":"CEO"}]'), out);
    assert.ok(out.includes('{"arr":100}'), out);
    assert.ok(out.includes("**Tags:** a, b"), out);
  } finally {
    api.restore();
  }
});

// --- 6. venture math --------------------------------------------------------------------------------

test("nuvc_venture_math with no figures says so and makes no call", async () => {
  const api = stubApi(() => ({}));
  try {
    const out = await h().nuvc_venture_math({ stage: "seed" });
    assert.match(out, /No figures were supplied/);
    assert.ok(!/null|Health Score/.test(out), out);
    assert.equal(api.calls.length, 0);
  } finally {
    api.restore();
  }
});

test("nuvc_venture_math prints a dash for a null metric", async () => {
  const api = stubApi((c) => (c.path.endsWith("/compute") ? { success: true, data: { burn_multiple: null, rule_of_40: 55.5 } } : { success: true, data: {} }));
  try {
    const out = await h().nuvc_venture_math({ arr: 1000000 });
    assert.ok(out.includes("| Burn Multiple | — |"), out);
    assert.ok(!out.includes("null"), out);
  } finally {
    api.restore();
  }
});

test("nuvc_venture_math says why the benchmark section was skipped", async () => {
  const api = stubApi((c) =>
    c.path.endsWith("/benchmark")
      ? { status: 422, body: { detail: [{ loc: ["body", "metrics"], msg: "ratio out of range", type: "x" }] } }
      : { success: true, data: { rule_of_40: 55 } }
  );
  try {
    const out = await h().nuvc_venture_math({ arr: 1000000 });
    assert.match(out, /Benchmark comparison skipped: .*metrics: ratio out of range/);
  } finally {
    api.restore();
  }
});

// --- 7. fund economics ------------------------------------------------------------------------------

const feeEconomicsRun = async (params, body) => {
  const economics = body || { success: true, data: { fund_health_score: 70, fee_economics: { fee_drag_pct: 12 } } };
  const api = stubApi((c) => (c.path.endsWith("/portfolio") ? { success: true, data: { fee_drag_pct: 9, investable_capital: 45 } } : economics));
  try {
    const out = await h().nuvc_fund_economics({ fund_size: 50_000_000, ...params });
    return { out, portfolio: api.calls.find((c) => c.path.endsWith("/portfolio")).body };
  } finally {
    api.restore();
  }
};

test("nuvc_fund_economics honours a fee of exactly 0: no assumption note, 0 on the portfolio call", async () => {
  const r = await feeEconomicsRun({ management_fee: 0, carry: 20 });
  assert.equal(r.portfolio.management_fee_rate, 0, "the portfolio call carries the explicit 0, not 2%");
  assert.ok(!r.out.includes("assumed"), r.out);
  assert.ok(!r.out.includes("treated as not given"), r.out);
  assert.ok(r.out.includes("| Fee Drag % |"), r.out);
  assert.ok(!r.out.includes("(assumed"), "neither Fee Drag label is marked assumed");
});

test("nuvc_fund_economics still assumes 2% and 20% when fee and carry are omitted or null", async () => {
  for (const params of [{}, { management_fee: null, carry: null }]) {
    const r = await feeEconomicsRun(params);
    assert.equal(r.portfolio.management_fee_rate, 0.02);
    assert.ok(r.out.includes("Fee Drag % (assumed 2% management fee and 20% carry)"), r.out);
    assert.ok(r.out.includes("| Fee Drag % (assumed 2% management fee) |"), "portfolio table label: " + r.out);
  }
  const given = await feeEconomicsRun({ management_fee: 1.5, carry: 25 });
  assert.equal(given.portfolio.management_fee_rate, 0.015);
  assert.ok(!given.out.includes("assumed"), given.out);
});

test("nuvc_fund_economics honours a carry of exactly 0 and still assumes an omitted fee", async () => {
  let r = await feeEconomicsRun({ management_fee: 2, carry: 0 });
  assert.equal(r.portfolio.management_fee_rate, 0.02);
  assert.ok(!r.out.includes("assumed") && !r.out.includes("treated as not given"), r.out);
  r = await feeEconomicsRun({ carry: 0 });
  assert.ok(r.out.includes("| Fee Drag % (assumed 2% management fee) |"), r.out);
  assert.ok(!r.out.includes("20% carry"), r.out);
});

test("nuvc_fund_economics lets the server's terms_assumed drive the notes", async () => {
  const body = (terms) => ({
    success: true,
    data: { fund_health_score: 70, fee_economics: { fee_drag_pct: 12, terms_assumed: terms, terms_basis: "partial" } },
  });
  // The server says only carry was imputed: the notes name carry alone, and the portfolio call uses the 3% sent.
  let r = await feeEconomicsRun({ management_fee: 3 }, body(["carry"]));
  assert.ok(r.out.includes("Fee Drag % (assumed 20% carry)"), r.out);
  assert.ok(!r.out.includes("assumed 2% management fee"), "the portfolio label is not marked assumed: " + r.out);
  assert.equal(r.portfolio.management_fee_rate, 0.03);
  // The server says nothing was imputed: no assumption note, and the portfolio call carries the 0 that was sent.
  r = await feeEconomicsRun({ management_fee: 0, carry: 0 }, body([]));
  assert.ok(!r.out.includes("assumed"), r.out);
  assert.equal(r.portfolio.management_fee_rate, 0);
  // Fee assumed per the server: the portfolio table is labelled the same way.
  r = await feeEconomicsRun({}, body(["management_fee", "preferred_return"]));
  assert.ok(r.out.includes("Fee Drag % (assumed 2% management fee)"), r.out);
  assert.ok(!r.out.includes("20% carry"), r.out);
});

test("nuvc_fund_economics says when the portfolio call failed, and when 2/20 were assumed", async () => {
  const api = stubApi((c) =>
    c.path.endsWith("/portfolio")
      ? { status: 422, body: { detail: [{ loc: ["body", "management_fee_rate"], msg: "Input should be less than or equal to 0.1", type: "x" }] } }
      : { success: true, data: { fund_health_score: 70, fee_economics: { fee_drag_pct: 12 } } }
  );
  try {
    const out = await h().nuvc_fund_economics({ fund_size: 50_000_000 });
    assert.match(out, /Portfolio section skipped: .*management_fee_rate: Input should be less than or equal to 0\.1/);
    assert.ok(out.includes("Fee Drag % (assumed 2% management fee and 20% carry)"), out);
    const given = await (async () => h().nuvc_fund_economics({ fund_size: 50_000_000, management_fee: 2, carry: 20 }))();
    assert.ok(!given.includes("assumed"), given);
  } finally {
    api.restore();
  }
});

// --- 8. mandate -------------------------------------------------------------------------------------

test("a string sectors value is kept as a list, on nuvc_set_mandate and as a one-off score mandate", async () => {
  const api = stubApi((c) => (c.path === "/ai/mandate" ? F.MANDATE_SET : F.SCORE));
  try {
    await h().nuvc_set_mandate({ sectors: "FinTech", stages: "seed, series_a" });
    assert.deepEqual(api.calls[0].body, { sectors: ["FinTech"], stages: ["seed", "series_a"] });
    await h().nuvc_score({ text: "x".repeat(20), mandate: { sectors: "AI/ML" } });
    assert.deepEqual(api.calls[1].body.mandate.sectors, ["AI/ML"]);
  } finally {
    api.restore();
  }
});

test("nuvc_set_mandate says it replaces the saved mandate", () => {
  assert.match(getTools().find((t) => t.name === "nuvc_set_mandate").description, /REPLACES the saved mandate/);
});

// --- 9. match grammar and pool size -----------------------------------------------------------------

test("nuvc_match_investors prints no pool size and gets the count grammar right", async () => {
  const one = { ...F.MATCH.data, matches: F.MATCH.data.matches.slice(0, 1), pool_size: "5800+" };
  const api = stubApi(() => ({ success: true, data: one }));
  try {
    const out = await h().nuvc_match_investors({ text: "A fintech for SMEs and their lenders" });
    assert.ok(out.includes("**1 investor** matched from the NUVC investor database"), out);
    assert.ok(!out.includes("5800"), out);
  } finally {
    api.restore();
  }
});
