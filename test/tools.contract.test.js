// Contract: every handler renders the same, non-empty output whether the API answers in
// snake_case (documented wire format) or camelCase (what the platform's response middleware
// produces on non-exempt routes). Reading only one casing silently renders an empty result
// for a paid credit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHandlers, field, camel, snake, snakeKeys } from "../lib/tools.js";
import { camelKeys, stubApi, KEY_A } from "./helpers.js";
import * as F from "./fixtures.js";

const ROUTES = {
  "POST /ai/score": F.SCORE,
  "POST /ai/match": F.MATCH,
  "POST /ai/screen-fund": F.SCREEN,
  "GET /ai/models": F.MODELS,
  "POST /ai/venture-math/compute": F.VENTURE,
  "POST /ai/venture-math/benchmark": F.BENCH,
  "POST /ai/venture-math/fund-economics": F.FUND_ECON,
  "POST /ai/venture-math/portfolio": F.PORTFOLIO,
  "GET /ai/mandate": F.MANDATE_GET,
  "POST /ai/mandate": F.MANDATE_SET,
};

const CASES = [
  ["nuvc_score", { text: "A fintech for SMEs" }, ["7.4", "Confidence: High (0.80)", "Problem Market", "Solid team", "ConvictionScore: 6.4 / 10", "Mutual fit: 71%", "Cheque too small", "Stage match"]],
  ["nuvc_match_investors", { text: "A fintech for SMEs" }, ["Jane Doe", "Acme Ventures", "87% match", "Tier 1", "$500K-$2M", "ANZ", "Backs seed fintech"]],
  ["nuvc_screen_fund", { fund_name: "Fund IV" }, ["Fund IV", "6.8 / 10", "Thin track record", "Gp Team Quality", "Strong GP", "No realised exits", "limited data"]],
  ["nuvc_models", {}, ["NUVC service status", "Scoring service: Available."]],
  ["nuvc_venture_math", { arr: 1000000 }, ["Burn Multiple", "LTV/CAC Ratio", "Rule of 40", "Financial Health Score", "Strong", "great 1.5", "No data"]],
  ["nuvc_fund_economics", { fund_size: 100000000 }, ["Fund Health Score", "Fee Drag %", "GP Carry %", "Top Quartile", "Balanced", "Gross Tvpi", "Top quartile: 2.50x", "Investable Capital", "Implied Portfolio Count", "Follow-On Reserve", "Total Deployment Capacity"]],
  ["nuvc_get_mandate", {}, ["FinTech", "$500,000"]],
];

function installRoutes(casing) {
  return stubApi((call) => {
    const body = ROUTES[`${call.method} ${call.path}`];
    assert.ok(body, `unexpected upstream call ${call.method} ${call.path}`);
    return casing === "camel" ? camelKeys(body) : body;
  });
}

for (const casing of ["snake", "camel"]) {
  for (const [tool, args, expected] of CASES) {
    test(`${tool} renders every field from a ${casing}_case response`, async () => {
      const api = installRoutes(casing);
      try {
        const out = await createHandlers(KEY_A)[tool](args);
        for (const needle of expected) assert.ok(out.includes(needle), `${tool}: missing "${needle}" in:\n${out}`);
        assert.ok(!/undefined|NaN|\[object Object\]/.test(out), `${tool}: leaked a bad value:\n${out}`);
      } finally {
        api.restore();
      }
    });
  }
}

test("benchmark request echoes metrics back snake_case even when compute answered camelCase", async () => {
  const api = installRoutes("camel");
  try {
    await createHandlers(KEY_A).nuvc_venture_math({ arr: 1000000, stage: "seed" });
    const bench = api.calls.find((c) => c.path === "/ai/venture-math/benchmark");
    assert.deepEqual(Object.keys(bench.body.metrics).sort(), ["burn_multiple", "financial_health_score", "ltv_cac_ratio", "rule_of_40"]);
  } finally {
    api.restore();
  }
});

test("an explicit per-call mandate is sent to /ai/score snake_case; none is injected otherwise", async () => {
  const api = installRoutes("camel");
  try {
    const h = createHandlers(KEY_A);
    await h.nuvc_get_mandate({});
    await h.nuvc_score({ text: "A fintech for SMEs" });
    await h.nuvc_score({ text: "A fintech for SMEs", mandate: { sectors: ["BioTech"], checkSizeMin: 1000 } });
    const [bare, explicit] = api.calls.filter((c) => c.path === "/ai/score");
    assert.equal(bare.body.mandate, undefined, "the account mandate is resolved server-side");
    assert.deepEqual(explicit.body.mandate, { sectors: ["BioTech"], check_size_min: 1000 });
  } finally {
    api.restore();
  }
});

test("legacy nested scores alias and flat contract both resolve overall_score", async () => {
  const flatOnly = { success: true, data: { overall_score: 5.5, summary: "ok" } };
  const nestedOnly = { success: true, data: { scores: { overall_score: 6.5, summary: "ok" } } };
  for (const [body, n] of [[flatOnly, "5.5"], [nestedOnly, "6.5"]]) {
    const api = stubApi(() => body);
    try {
      assert.ok((await createHandlers(KEY_A).nuvc_score({ text: "x".repeat(20) })).includes(`Overall: ${n} / 10`));
    } finally {
      api.restore();
    }
  }
});

test("a double-wrapped {success, data: {data}} venture-math body is unwrapped", async () => {
  const api = stubApi((c) =>
    c.path.endsWith("/compute") ? { success: true, data: F.VENTURE } : { success: true, data: F.BENCH }
  );
  try {
    const out = await createHandlers(KEY_A).nuvc_venture_math({ arr: 1 });
    assert.ok(out.includes("Burn Multiple"));
  } finally {
    api.restore();
  }
});

test("casing helpers round-trip and match the middleware transform", () => {
  assert.equal(camel("fit_for_investor"), "fitForInvestor");
  assert.equal(snake("fitForInvestor"), "fit_for_investor");
  assert.equal(snake("Team"), "team");
  assert.equal(field({ overallScore: 0 }, "overall_score"), 0); // 0 is a real value, not absent
  assert.equal(field({ overall_score: 3 }, "overall_score"), 3);
  assert.equal(field(null, "x"), undefined);
  assert.deepEqual(snakeKeys({ aB: [{ cD: 1 }] }), { a_b: [{ c_d: 1 }] });
});

test("package.json version matches the manifests that carry it", () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  const v = JSON.parse(read("package.json")).version;
  assert.equal(JSON.parse(read("manifest.json")).version, v);
  const versions = read("smithery.yaml").split(/\r?\n/).filter((line) => line.startsWith("version: ")).map((line) => line.slice("version: ".length));
  assert.deepEqual(versions, [v]);
});

test("nuvc_match_investors makes no pool-size claim when the API omits pool_size", async () => {
  const { pool_size, ...data } = F.MATCH.data;
  const api = stubApi(() => ({ ...F.MATCH, data }));
  try {
    const out = await createHandlers(KEY_A).nuvc_match_investors({ text: "A fintech for SMEs" });
    assert.ok(out.includes("matched from the NUVC investor database"), out);
    assert.ok(!/\d[\d,]*\+/.test(out), `unexpected count claim in:\n${out}`);
  } finally {
    api.restore();
  }
});


for (const casing of ["snake", "camel"]) {
  test(`conviction renders once on the public 0-10 scale from ${casing}_case data`, async () => {
    for (const [raw, expected] of [[0, 0], [70, 7], [100, 10], [64, 6.4]]) {
      const body = { success: true, data: { fit: { conviction_score: raw, decision: "watch" } } };
      const api = stubApi(() => casing === "camel" ? camelKeys(body) : body);
      try {
        const out = await createHandlers(KEY_A).nuvc_score({ text: "A fintech for SMEs" });
        assert.ok(out.includes(`ConvictionScore: ${expected} / 10**`), out);
        assert.doesNotMatch(out, /\/ 100/);
      } finally { api.restore(); }
    }
  });

  test(`invalid or missing conviction is omitted from ${casing}_case data`, async () => {
    for (const raw of [undefined, null, "70", false, -1, 101, NaN, Infinity, {}, []]) {
      const body = { success: true, data: { fit: { conviction_score: raw, decision: "watch" } } };
      const api = stubApi(() => casing === "camel" ? camelKeys(body) : body);
      try {
        const out = await createHandlers(KEY_A).nuvc_score({ text: "A fintech for SMEs" });
        assert.doesNotMatch(out, /ConvictionScore:/);
        assert.match(out, /Mandate Fit/);
      } finally { api.restore(); }
    }
  });
}
