// Snake_case wire bodies for each endpoint the MCP reads, mirroring the backend producers.
// Contract checks pin the field names used here against the API response models,
// so these fixtures cannot drift from the API silently.
export const SCORE = {
  success: true,
  data: {
    overall_score: 7.4,
    confidence: 0.8,
    summary: "Solid team, thin traction.",
    scores: {
      overall_score: 7.4,
      summary: "Solid team, thin traction.",
      scores: { problem_market: { score: 8, rationale: "Large market" } },
    },
    fit: {
      conviction_score: 64,
      decision: "watch",
      mutual_fit: 0.71,
      mutual_fit_label: "Good",
      fit_for_investor: { score: 0.8, passes: ["Sector fit"], fails: ["Cheque too small"] },
      fit_for_founder: { score: 0.6, reasons: ["Stage match"] },
    },
  },
};

export const MATCH = {
  success: true,
  data: {
    matches: [
      {
        investor_name: "Jane Doe",
        firm_name: "Acme Ventures",
        match_score: 0.87,
        match_quality: "strong",
        thesis_snippet: "Backs seed fintech",
        industries: ["FinTech"],
        funding_stages: ["seed"],
        location: "Sydney",
        geographic_focus: "ANZ",
        check_size_display: "$500K-$2M",
        lead_investor_badge: "Lead",
        investor_tier_label: "Tier 1",
        value_add_tags: ["Network"],
        reasoning: "Thesis aligns",
        website: "https://acme.vc",
      },
    ],
    pool_size: "5800+",
    matching_method: "semantic_embedding",
    latency_ms: 120,
  },
};

export const SCREEN = {
  success: true,
  data: {
    fund_name: "Fund IV",
    screening_score: 6.8,
    confidence: "medium",
    decision: "Watch",
    decision_reason: "Thin track record",
    verdict: "Promising but unproven.",
    dimensions: { gp_team_quality: 7.1, deal_flow_access: 6.2 },
    strengths: ["Strong GP"],
    red_flags: ["No realised exits"],
    insufficient_data: true,
  },
};

export const MODELS = {
  success: true,
  data: {
    providers: [{ name: "openai", available: true, healthy: true }],
    preference: ["openai"],
    embedding_models: ["text-embedding-3-small"],
  },
};

export const VENTURE = { data: { burn_multiple: 1.8, ltv_cac_ratio: 4.2, rule_of_40: 52, financial_health_score: 7.5 } };
export const BENCH = {
  data: {
    burn_multiple: { value: 1.8, great: 1.5, good: 3.0, concern: 8.0, signal: "strong" },
    arr_multiple: { value: null, great: 15, good: 40, concern: 100, signal: "unknown" },
  },
  stage: "seed",
};
export const FUND_ECON = {
  data: {
    fund_health_score: 7.5,
    fee_economics: { fee_drag_pct: 15.6, total_lifetime_fees: 15625000, investable_capital: 84375000 },
    gp_alignment: { carry_pct_of_total: 30.4, aligned: false },
    jcurve_position: { performance_vs_peers: "top_quartile", fund_age_years: 6 },
    concentration: { concentration_label: "balanced" },
    return_decomposition: { gross_tvpi: 2.5 },
    signals: ["Top quartile: 2.50x TVPI"],
    metrics_available: 8,
  },
};
export const PORTFOLIO = {
  data: { investable_capital: 80000000, implied_portfolio_count: 25, fee_drag_pct: 12, follow_on_reserve: 40000000, total_deployment_capacity: 120000000 },
};
export const MANDATE_GET = { success: true, data: { mandate: { sectors: ["FinTech"], check_size_min: 500000 } } };
export const MANDATE_SET = { success: true, data: { mandate: { sectors: ["FinTech"] }, persisted: true } };
