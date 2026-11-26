// Investor-workspace read tools: nuvc_my_deals, nuvc_deal_brief, nuvc_precedent.
// /vc/* is NOT camelCase-exempt, so the fake API answers the way prod does: {success, data, message}
// with camelCased keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandlers, getTools } from "../lib/tools.js";
import { UNTRUSTED_NOTICE } from "../lib/own-data.js";
import { WORKSPACE_TOOL_NAMES, NOT_ENABLED, NO_ACCESS, NO_PRECEDENT } from "../lib/workspace-tools.js";
import { camelKeys, stubApi, KEY_A } from "./helpers.js";

const DECK = "3f2b8c1e-5a4d-4e7b-9c0a-1b2c3d4e5f60";
const OTHER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const envelope = (data) => ({ success: true, data: camelKeys(data), message: "ok" });

const LIBRARY = {
  items: [
    {
      deck_id: DECK, evaluation_id: "e1", source: "upload", company: "Acme Robotics", stage: "seed",
      score: { value: 7.2, scale: "0-10", lens_adjusted: 6.9, label: "Strong" },
      founder: { name: "Ada", credential: "ex-Atlassian", avatar: "https://x/a.png" },
      contact_state: "available", contact: { email: "ada@acme.test", linkedin_url: "https://li/ada" },
      last_activity: "2026-10-27T00:00:00Z",
    },
    {
      deck_id: OTHER, evaluation_id: "e2", source: "nuvc", company: "Beta Health", stage: "pre_seed",
      score: { value: null, scale: "0-10", lens_adjusted: null, label: null },
      founder: null, contact_state: "request_intro",
      // A body that carries contact anyway must still not surface it.
      contact: { email: "hidden@beta.test", linkedin_url: null },
      founder_email: "raw@beta.test", extracted_text: "SECRET DECK TEXT", owner_user_id: "u-other",
      last_activity: "2026-10-20T00:00:00Z",
    },
  ],
  total: 2, page: 1, limit: 25, has_more: false, truncated: false, partial: false,
  counts_by_source: { upload: 1, screened: 0, nuvc: 1, portfolio: 0 },
};

const BRIEF = {
  verdict: {
    available: true, sentence: "Acme Robotics: 7.2/10 mandate fit, medium confidence — worth a first meeting.",
    action: "advance", score: 7.2, confidence_label: "medium", basis: "mandate_conviction",
  },
  signals: [
    { text: "Team scores 8.1/10 (strong)", source_key: "team", polarity: "positive" },
    { text: "Thin runway", source_key: "enhanced_red_flags", polarity: "risk" },
    { text: "Paying pilots", source_key: "green_flags", polarity: "positive" },
    { text: "a fourth signal", source_key: "x", polarity: "positive" },
  ],
  open_questions: [{ text: "The deck does not cover the raise and use of funds.", source_key: "deck_completeness" }],
  precedent: { available: false, reason: "Fewer than 3 similar deals you decided on — no precedent to show." },
  thesis_fit: { available: true, pct: 74, confidence_label: "medium", aligned: ["Stage"], misaligned: [] },
  comps: { available: true, label: "same sector + stage", items: [{ name: "Gamma", outcome: "acquired", oneLiner: "x", cohortYear: 2021, internal_id: "zz" }] },
  extracted_text: "SECRET DECK TEXT",
  scoring_breakdown: { weights: { team: 0.3 } },
  category_weights: { team: 0.3 },
};

const PRECEDENT = {
  precedent: {
    n: 4, decision_counts: { pass: 4 },
    top_reasons: [{ id: "market_too_small", label: "Market too small", count: 3 }],
    items: [{ deck_id: OTHER, decision: "pass", reasons: ["market_too_small"], score_at_decision: 5.1, decided_at: "2026-09-01", company_name: "Delta", investor_profile_id: "p-1" }],
    basis: "sector+stage+geo",
  },
};

function api(routes) {
  return stubApi((call) => {
    const hit = routes[`${call.method} ${call.path.split("?")[0]}`];
    if (!hit) return { status: 404, body: { success: false, error: { message: "Not found" } } };
    return typeof hit === "function" ? hit(call) : hit;
  });
}

const payload = (out) => JSON.parse(out.slice(out.indexOf("```json") + 7, out.lastIndexOf("```")));

test("tools list includes the three read tools and no write tools", () => {
  const tools = getTools();
  const names = tools.map((t) => t.name);
  for (const n of ["nuvc_my_deals", "nuvc_deal_brief", "nuvc_precedent"]) assert.ok(names.includes(n), `${n} advertised`);
  assert.deepEqual(WORKSPACE_TOOL_NAMES.sort(), ["nuvc_deal_brief", "nuvc_my_deals", "nuvc_precedent"]);
  for (const t of tools.filter((x) => WORKSPACE_TOOL_NAMES.includes(x.name))) {
    assert.match(t.description, /read-only/);
    assert.ok(!/calibrat|beats|superintelligence|gpt-|claude-|table/i.test(t.description), t.name);
  }
  assert.ok(!names.some((n) => /write|apply|preview|update|delete|create|set_deal/.test(n) && n !== "nuvc_set_mandate"));
  const handlers = createHandlers(KEY_A);
  for (const n of WORKSPACE_TOOL_NAMES) assert.equal(typeof handlers[n], "function");
});

test("rejects foreign identity args", async () => {
  const fake = api({});
  try {
    const h = createHandlers(KEY_A);
    for (const [tool, args] of [
      ["nuvc_my_deals", { investor_id: "x" }],
      ["nuvc_my_deals", { userId: "x" }],
      ["nuvc_deal_brief", { deck_id: DECK, investor_profile_id: "x" }],
      ["nuvc_deal_brief", { deck_id: DECK, firm_id: "x" }],
      ["nuvc_precedent", { deck_id: DECK, owner_id: "x" }],
      ["nuvc_precedent", { deck_id: DECK, profileId: "x" }],
    ]) {
      await assert.rejects(h[tool](args), /is not accepted/, `${tool} ${JSON.stringify(args)}`);
    }
    assert.equal(fake.calls.length, 0, "no upstream call for a rejected argument");
  } finally {
    fake.restore();
  }
});

test("rejects non-uuid deck_id", async () => {
  const fake = api({});
  try {
    const h = createHandlers(KEY_A);
    for (const bad of [undefined, "", "123", "../ai/score", `${DECK}/../x`]) {
      await assert.rejects(h.nuvc_deal_brief({ deck_id: bad }), /deck_id must be/);
      await assert.rejects(h.nuvc_precedent({ deck_id: bad }), /deck_id must be/);
    }
    assert.equal(fake.calls.length, 0);
  } finally {
    fake.restore();
  }
});

test("maps 404 flag-off to friendly message", async () => {
  const fake = api({});
  try {
    const h = createHandlers(KEY_A);
    await assert.rejects(h.nuvc_my_deals({}), (e) => e.message === NOT_ENABLED);
    await assert.rejects(h.nuvc_deal_brief({ deck_id: DECK }), (e) => e.message.startsWith(NOT_ENABLED));
    await assert.rejects(h.nuvc_precedent({ deck_id: DECK }), (e) => e.message.startsWith(NOT_ENABLED));
  } finally {
    fake.restore();
  }
  // Only a 403 means "no access to the workspace"; a 401 is the shared key handling (see errors.test.js).
  const denied = stubApi(() => ({ status: 403, body: { detail: { error: "investor_profile_required" } } }));
  try {
    await assert.rejects(createHandlers(KEY_A).nuvc_my_deals({}), (e) => e.message === NO_ACCESS);
  } finally {
    denied.restore();
  }
});

test("strips contact unless contact_state available", async () => {
  const fake = api({ "GET /vc/deal-library": envelope(LIBRARY) });
  try {
    const out = await createHandlers(KEY_A).nuvc_my_deals({ source: "upload", limit: 500 });
    const data = payload(out);
    assert.deepEqual(data.items[0].contact, { email: "ada@acme.test", linkedin_url: "https://li/ada" });
    assert.equal(data.items[1].contact, undefined);
    assert.ok(!out.includes("hidden@beta.test") && !out.includes("raw@beta.test"));
    assert.ok(!out.includes("founder_email") && !out.includes("avatar"));
    assert.match(fake.calls[0].path, /^\/vc\/deal-library\?page=1&limit=50&source=upload$/, "limit capped at 50");
    await assert.rejects(createHandlers(KEY_A).nuvc_my_deals({ source: "everyone" }), /source must be one of/);
  } finally {
    fake.restore();
  }
});

test("never returns extracted_text or unknown keys", async () => {
  const fake = api({
    [`GET /vc/deals/${DECK}/brief`]: envelope(BRIEF),
    [`GET /vc/deals/${DECK}/precedent`]: envelope(PRECEDENT),
    "GET /vc/deal-library": envelope(LIBRARY),
  });
  try {
    const h = createHandlers(KEY_A);
    const outs = [await h.nuvc_deal_brief({ deck_id: DECK }), await h.nuvc_precedent({ deck_id: DECK }), await h.nuvc_my_deals({})];
    for (const out of outs) {
      for (const leak of ["SECRET DECK TEXT", "extracted_text", "scoring_breakdown", "category_weights", "weights",
                          "owner_user_id", "u-other", "investor_profile_id", "internal_id"]) {
        assert.ok(!out.includes(leak), `leaked ${leak}:\n${out}`);
      }
    }
    const brief = payload(outs[0]);
    assert.equal(brief.signals.length, 3, "at most 3 signals");
    assert.deepEqual(Object.keys(brief).sort(), ["comps", "open_questions", "precedent", "signals", "thesis_fit", "verdict"]);
    assert.match(outs[0], /worth a first meeting/);
    assert.deepEqual(brief.comps.items[0], { name: "Gamma", outcome: "acquired", one_liner: "x", cohort_year: 2021 });
  } finally {
    fake.restore();
  }
});

test("unwraps {success,data} envelope and camelCase", async () => {
  for (const wire of ["camel", "snake"]) {
    const wrap = (d) => (wire === "camel" ? envelope(d) : { success: true, data: d, message: "ok" });
    const fake = api({
      "GET /vc/deal-library": wrap(LIBRARY),
      [`GET /vc/deals/${DECK}/precedent`]: wrap(PRECEDENT),
      [`GET /vc/deals/${OTHER}/precedent`]: wrap({ precedent: null, reason: "fewer_than_3_similar_decisions" }),
    });
    try {
      const h = createHandlers(KEY_A);
      const deals = payload(await h.nuvc_my_deals({}));
      assert.equal(deals.items[0].company, "Acme Robotics");
      assert.equal(deals.items[0].contact_state, "available");
      assert.equal(deals.items[0].score.lens_adjusted, 6.9);
      assert.deepEqual(deals.counts_by_source, { upload: 1, screened: 0, nuvc: 1, portfolio: 0 });
      const prec = payload(await h.nuvc_precedent({ deck_id: DECK.toUpperCase() }));
      assert.equal(prec.n, 4);
      assert.equal(prec.top_reasons[0].label, "Market too small");
      assert.equal(prec.items[0].score_at_decision, 5.1);
      assert.equal(await h.nuvc_precedent({ deck_id: OTHER }), NO_PRECEDENT);
      assert.ok(fake.calls.every((c) => c.key === KEY_A && c.method === "GET"), "caller's own key, reads only");
      assert.ok(fake.calls.some((c) => c.path === `/vc/deals/${DECK}/precedent`), "deck id normalised to lower case");
    } finally {
      fake.restore();
    }
  }
});

test("brief: the verdict sentence lives inside the JSON block, not the heading, and the result is marked as data", async () => {
  const fake = api({ [`GET /vc/deals/${DECK}/brief`]: envelope(BRIEF) });
  try {
    const out = await createHandlers(KEY_A).nuvc_deal_brief({ deck_id: DECK });
    assert.ok(out.startsWith(UNTRUSTED_NOTICE + "\n\n## Decision brief (read-only)\n\n```json"), out.slice(0, 200));
    const outside = out.slice(0, out.indexOf("```json"));
    assert.ok(!outside.includes("worth a first meeting"), "sentence must not be interpolated outside the fenced block");
    assert.equal(payload(out).verdict.sentence, BRIEF.verdict.sentence);
  } finally {
    fake.restore();
  }
});
