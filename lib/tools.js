import { readBilling } from "./billing.js";
/**
 * NUVC tool definitions and handlers — shared by stdio and HTTP transports.
 */

import { WORKSPACE_TOOLS, createWorkspaceHandlers } from "./workspace-tools.js";
import { assertNoForeignIdentityArgs, cleanText, withAnnotations, withUntrustedNotice } from "./own-data.js";

const API_BASE = "https://api.nuvc.ai/api/v3"; // one API host for both audiences (nuvc-mcp and repyh-mcp)
const TIMEOUT_MS = 30_000;

// NOTE: no module-level mutable state. The active mandate (and the API key) live in a
// per-session context built by createHandlers(), so concurrent HTTP callers can never see
// each other's mandate or spend each other's credits.

// Build a clean mandate object from loosely-typed args (drop empty fields).
// A model client sometimes sends "FinTech" or "FinTech, AI/ML" where a list is expected; accept both.
function toList(v) {
  const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return items.map((x) => String(x).trim()).filter(Boolean);
}

function buildMandate(rawArgs = {}) {
  const args = snakeKeys(rawArgs || {});
  const m = {};
  const sectors = toList(args.sectors);
  const stages = toList(args.stages);
  if (sectors.length) m.sectors = sectors;
  if (stages.length) m.stages = stages;
  if (args.geography) m.geography = args.geography;
  if (args.check_size_min != null) m.check_size_min = args.check_size_min;
  if (args.check_size_max != null) m.check_size_max = args.check_size_max;
  if (args.thesis) m.thesis = args.thesis;
  if (args.anti_thesis) m.anti_thesis = args.anti_thesis;
  return Object.keys(m).length ? m : null;
}

// ---------------------------------------------------------------------------
// Response-shape helpers
//
// The API's documented wire format is snake_case, but the platform's
// ResponseStandardizationMiddleware camelCases JSON bodies on every route that is
// not exempt (/api/v3/ai/* is exempt today). A client that reads one casing
// silently gets `undefined` and renders an empty result for a paid credit, so
// every response read goes through `field()` — camelCase first, snake_case
// fallback — and every dict we iterate is normalised through `snake()`.
// The backend contract test pins every
// `field(<obj>, "<name>")` literal in this file against the backend response
// models, so a renamed backend field fails CI instead of failing a customer.
// ---------------------------------------------------------------------------

/** snake_case -> camelCase, identical to the middleware's key transform. */
export function camel(key) {
  if (typeof key !== "string" || !key.includes("_")) return key;
  const [head, ...rest] = key.split("_");
  return head + rest.map((x) => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase()).join("");
}

/**
 * camelCase -> snake_case. Splits a lower/digit -> Upper boundary and a letter -> digit
 * boundary, so the middleware's `rule_of_40` -> `ruleOf40` round-trips. (A key that is
 * genuinely `foo2bar` in snake_case would not; no field this client reads has one.)
 */
export function snake(key) {
  if (typeof key !== "string") return key;
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([a-zA-Z])(\d)/g, "$1_$2")
    .toLowerCase();
}

/** Deep-convert object keys to snake_case (for echoing a response back as a request body). */
export function snakeKeys(value) {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [snake(k), snakeKeys(v)]));
  }
  return value;
}

/** Read `key` (given in snake_case) from `obj`: camelCase first, snake_case fallback. */
export function field(obj, key) {
  if (obj === null || obj === undefined || typeof obj !== "object") return undefined;
  return obj[camel(key)] ?? obj[key];
}

/** Human label from either casing: `problem_market` / `problemMarket` -> "Problem Market". */
function label(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Unwrap the success envelope. Some routes (venture-math) return `{data: result}`
 * and the standardisation middleware wraps a bare `{data}` a second time
 * (`{success, data: {data: result}}`), so peel one extra level when the
 * inner object is itself just a `data` carrier.
 */
function unwrap(res) {
  let d = res?.data ?? res;
  if (
    d && typeof d === "object" && !Array.isArray(d) &&
    d.data && typeof d.data === "object" && !Array.isArray(d.data) &&
    Object.keys(d).every((k) => ["data", "stage", "message", "success"].includes(k))
  ) {
    d = d.data;
  }
  return d;
}

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

/** Founder (REPYH) keys are `repyh_...`; they belong to the repyh-mcp package, never this one. */
const FOUNDER_KEY_PREFIX = "repyh_";

const FOUNDER_KEY_MESSAGE =
  "This is a REPYH founder key, and nuvc-mcp is the investor package. Use repyh-mcp for founder workflows; " +
  "nuvc-mcp@1.4.1 retains legacy behavior. An investor key starts with nuvc_.";

/** True when `key` is a REPYH founder key (refused here before any network call). */
export function isFounderKey(key) {
  return typeof key === "string" && key.startsWith(FOUNDER_KEY_PREFIX);
}

/** Why a key was refused: the founder-key message, or the generic missing/invalid one. */
export function apiKeyProblem(key) {
  if (isFounderKey(key)) return FOUNDER_KEY_MESSAGE;
  return "NUVC_API_KEY not set or invalid. Get a free key at https://nuvc.ai/api-platform/keys";
}

/**
 * Resolve + validate the caller's API key. `source` is a key string (HTTP mode: the
 * caller's own key from their request) or a function returning one (stdio mode: the
 * local env var). There is deliberately NO fallback to process.env here — in HTTP mode
 * a shared server key would proxy every anonymous caller through one account.
 */
function resolveApiKey(source) {
  const raw = typeof source === "function" ? source() : source;
  if (!isValidApiKey(raw)) throw new Error(apiKeyProblem(raw)); // never echoes the key
  return raw.trim();
}

// Whole-key check, not prefix-only: a key with a newline or other control character must never reach
// fetch, whose error text would carry the whole `Bearer ...` header value into the transcript.
const INVESTOR_KEY_RE = /^nuvc_[A-Za-z0-9_]+$/;

/** True when `key` is shaped like a NUVC investor API key (cheap pre-check for transports). */
export function isValidApiKey(key) {
  return typeof key === "string" && INVESTOR_KEY_RE.test(key.trim());
}

/** Text of an upstream value that may be a string or an object, never "[object Object]". */
function textOf(v) {
  if (v !== null && typeof v === "object") {
    try { return cleanText(JSON.stringify(v)); } catch { return ""; }
  }
  return cleanText(v);
}

const pickStr = (...vs) => vs.find((v) => typeof v === "string" && v.trim());

/**
 * One reading of an API error body, whichever shape it arrives in:
 *   plain       {detail: "..." | {code|error, message} | [{loc, msg}]}            (/api/v3/ai/*, not rewritten)
 *   wrapped     {success: false, error: {detail: ...} | {code, message} | "text", message: "Request failed"}
 *               (routes behind the response middleware rewrite a body with no `success` or `error` key this way,
 *               camelCasing the keys; the top-level message is a generic one and is ignored)
 * Returns { code, message, list }: `code` (an upper- or lower-case machine code such as QUOTA_EXCEEDED or
 * product_scope_mismatch, else undefined), `message` (clean text, else ""), `list` (a validation list as
 * "field: message" strings, else []). Tolerant of camelCase and snake_case keys.
 */
export function errorInfo(body) {
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const none = { code: undefined, message: "", list: [] };
  if (!isObj(body)) return none;
  // Descend through nested `error` objects (the middleware wraps, a route may wrap again) until one holds `detail`.
  let node = body;
  let hops = 0;
  while (node.detail == null && isObj(node.error) && hops < 3) {
    node = node.error;
    hops += 1;
  }
  const e = node.error;
  let d = node.detail;
  if (d === undefined || d === null) d = hops > 0 ? node : typeof e === "string" ? e : undefined;
  const obj = isObj(d) ? d : null;
  const list = Array.isArray(d)
    ? d.map((x) => {
        const loc = Array.isArray(x?.loc) ? x.loc.filter((y) => y !== "body") : [];
        const name = loc.length ? cleanText(loc[loc.length - 1]) : "";
        const msg = typeof x?.msg === "string" ? cleanText(x.msg) : textOf(x);
        return name ? `${name}: ${msg}` : msg;
      })
    : [];
  // A platform error with a string `error` code and its own top-level `message` (the middleware's generic
  // "Request failed" is not a message).
  const topMessage = typeof e === "string" && !/^request failed$/i.test(String(node.message).trim()) ? pickStr(node.message) : undefined;
  const code = pickStr(obj?.code, obj?.error, node.code, topMessage ? e : undefined);
  let message = "";
  if (topMessage) message = cleanText(topMessage);
  else if (typeof d === "string") message = cleanText(d);
  else if (obj) message = cleanText(pickStr(obj.message) ?? "");
  return { code, message, list };
}

/**
 * Readable text for an error: its message, else its validation list (first 5), else an odd object detail as compact
 * JSON (never "[object Object]"), else `fallback`.
 */
function errorDetailText(info, body, fallback) {
  if (info.message) return info.message;
  if (info.list.length) {
    const shown = info.list.slice(0, 5);
    return shown.join("; ") + (info.list.length > shown.length ? ` (and ${info.list.length - shown.length} more)` : "");
  }
  const d = body?.detail ?? body?.error?.detail ?? body?.error;
  if (d !== null && typeof d === "object" && !Array.isArray(d) && Object.keys(d).length) return textOf(d);
  return cleanText(fallback) || "no details were returned";
}

/**
 * Read a JSON body, giving up when the call's own timeout aborts. Awaited inside the timed section: a server that
 * sends headers and then stalls must not outlive the limit.
 */
function readJson(res, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => res.json()).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** `opts.timeoutMs` shortens the wait for a call that must never hold up a response (the toolset lookup). */
export function createApiCall(keySource) {
  return async function apiCall(method, path, body, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${resolveApiKey(keySource)}`,
          "Content-Type": "application/json",
          "User-Agent": "nuvc-mcp/2.0",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await readJson(res, controller.signal).catch((e) => (e?.name === "AbortError" ? Promise.reject(e) : {}));
        const info = errorInfo(err);
        const msg = errorDetailText(info, err, res.statusText);
        // `status`, `code` and `apiMessage` let a tool map a failure to its own message (workspace tools).
        const fail = (message, extra = {}) => Object.assign(new Error(message), { status: res.status, code: info.code, apiMessage: info.message, ...extra });
        if (res.status === 401) {
          const expired = /expired/i.test(msg)
            ? " Keys expire (30 days by default); create a new key at https://nuvc.ai/api-platform/keys."
            : "";
          throw fail(`Auth error: ${msg}. Check NUVC_API_KEY at https://nuvc.ai/api-platform/keys${expired}`);
        }
        if (res.status === 402) {
          throw fail("This action needs account access or score credits. Use nuvc_billing to check your balance, tool costs and any eligible purchase options (free read). Review and confirm any purchase in your browser; do not repeat this action automatically.");
        }
        if (res.status === 429) {
          // A spent monthly quota carries its own code and message; waiting does not help there.
          if (info.code === "QUOTA_EXCEEDED") throw fail("Your monthly quota is used up. Use nuvc_billing to check the reset date, tool costs and your account options (free read). A credit pack does not extend every tool's quota; do not repeat this action automatically.");
          const retry = res.headers.get("retry-after");
          const seconds = typeof retry === "string" && /^\d+$/.test(retry) ? Number(retry) : NaN;
          const wait = Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 86400
            ? `Wait at least ${seconds} seconds before trying again.`
            : "Wait a moment before trying again.";
          throw fail(`Rate limit reached. ${wait} Do not retry continuously.`);
        }
        throw fail(`API error (${res.status}): ${msg}`);
      }
      return await readJson(res, controller.signal);
    } catch (err) {
      if (err.name === "AbortError") throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const INVESTOR_TOOLS = [
  { name: "nuvc_billing", description: "Read your current credit balance, monthly quota, tool costs and available pack price. No purchase or charge. Example: What will this cost?", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "nuvc_score",
    description:
      "Screen a pitch deck or startup the way an investment committee would: a 0-10 score across 5 dimensions " +
      "(Problem & Market, Solution & Product, Business Model, Traction & Metrics, and Team & Execution), " +
      "with a confidence level and a short summary. " +
      "If your firm has a saved mandate (nuvc_set_mandate) — or you pass one here — the result also includes a " +
      "TWO-WAY mandate<->deck fit: Direction A (does this deck fit YOUR thesis?), Direction B (would the " +
      "founder want YOU?), a mutual-fit score, a 0-10 ConvictionScore, and a proceed/watch/pass decision.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 10, maxLength: 500000, description: "Business idea, startup description, or pitch content to score (10 to 500,000 characters)" },
        mandate: {
          type: "object",
          description:
            "Optional one-off mandate to score this deck against. If omitted, your firm account's saved " +
            "mandate (nuvc_set_mandate), if any, is used. Supplying it triggers the two-way fit verdict.",
          properties: {
            sectors: { type: "array", items: { type: "string" }, description: "Sectors you back (e.g. ['FinTech','AI/ML'])" },
            stages: { type: "array", items: { type: "string" }, description: "Stages you invest at (pre_seed..growth)" },
            geography: { type: "string", description: "Your geographic focus (e.g. 'ANZ', 'global')" },
            check_size_min: { type: "number", minimum: 0, description: "Minimum cheque (USD)" },
            check_size_max: { type: "number", minimum: 0, description: "Maximum cheque (USD)" },
            thesis: { type: "string", maxLength: 5000, description: "Your investment thesis (up to 5,000 characters)" },
            anti_thesis: { type: "string", maxLength: 5000, description: "What you never back (up to 5,000 characters)" },
          },
        },
        stage: { type: "string", description: "This deal's stage (sharpens fit), e.g. 'seed'" },
        industry: { type: "string", description: "This deal's primary sector, e.g. 'FinTech'" },
        geography: { type: "string", description: "This company's location/geo" },
        raise_amount: { type: "number", description: "This deal's target raise (USD) — drives the cheque-fit check" },
      },
      required: ["text"],
    },
  },
  {
    name: "nuvc_set_mandate",
    description:
      "Save your firm's investor mandate (sector focus, stages, cheque size, thesis, anti-thesis) to the NUVC " +
      "account that owns this API key. Once saved, every nuvc_score call made with that account's keys (here, " +
      "REST, or web) returns a two-way mandate<->deck fit automatically. The mandate belongs to the firm " +
      "account, not to the session or the client. This REPLACES the saved mandate: any field you omit is cleared, " +
      "so pass every field you want to keep. Use nuvc_get_mandate to review it.",
    inputSchema: {
      type: "object",
      properties: {
        sectors: { type: "array", items: { type: "string" }, description: "Sectors you back (e.g. ['FinTech','AI/ML'])" },
        stages: { type: "array", items: { type: "string" }, description: "Stages you invest at (pre_seed, seed, series_a, series_b, series_c, growth)" },
        geography: { type: "string", description: "Your geographic focus (e.g. 'ANZ', 'US', 'global')" },
        check_size_min: { type: "number", minimum: 0, description: "Minimum cheque you write (USD)" },
        check_size_max: { type: "number", minimum: 0, description: "Maximum cheque you write (USD)" },
        thesis: { type: "string", maxLength: 5000, description: "Your investment thesis in plain language (up to 5,000 characters)" },
        anti_thesis: { type: "string", maxLength: 5000, description: "What you never back (deal-breakers; up to 5,000 characters)" },
      },
    },
  },
  {
    name: "nuvc_get_mandate",
    description: "Show the mandate saved on the firm account that owns this API key (used by nuvc_score for two-way fit).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nuvc_analyze",
    description:
      "Analyze a market, competitive landscape, financial data, or full pitch deck. " +
      "Returns structured analysis with insights, opportunities, and risks.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 10, maxLength: 500000, description: "Content to analyze (10 to 500,000 characters)" },
        analysis_type: {
          type: "string",
          enum: ["market", "competitive", "financial", "pitch_deck", "general"],
          description: "Type of analysis. Defaults to 'market'.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "nuvc_extract",
    description:
      "Extract structured data from pitch text. Returns fields like revenue, growth rate, team size, funding stage, and key metrics.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 10, maxLength: 500000, description: "Pitch or business description to extract data from (10 to 500,000 characters)" },
        extraction_type: {
          type: "string",
          enum: ["general", "company", "financial", "contact"],
          description: "Type of extraction. Defaults to 'company'.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "nuvc_models",
    description: "List available AI models, provider health, and embedding models.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nuvc_match_investors",
    description:
      "Find co-investors, syndicate partners, and likely lead investors for a deal — a ranked, thesis-fit shortlist " +
      "from NUVC's investor database (a well-matched few beats a mass blast to hundreds). " +
      "Uses AI semantic matching (embeddings) to compare the startup description against each investor's " +
      "thesis, focus areas, stage preference, and track record. Returns ranked matches, each with a reason " +
      "and brief — thesis-alignment reasoning, check size ranges, and investor quality signals. " +
      "Contact details are available on the NUVC platform. This tool cannot be replicated locally — " +
      "it searches a proprietary, continuously enriched investor database.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "Startup description, pitch content, or company summary to match against investors. " +
            "The more detail you provide, the better the matches. At least 20 characters.",
          minLength: 20,
        },
        industry: {
          type: "string",
          description: "Primary industry/sector (e.g. 'FinTech', 'HealthTech', 'SaaS', 'AI/ML'). Default: 'Technology'.",
        },
        stage: {
          type: "string",
          enum: ["pre_seed", "seed", "series_a", "series_b", "series_c", "growth"],
          description: "Current funding stage. Default: 'seed'.",
        },
        raise_amount: {
          type: "number",
          description: "Target raise amount in USD (helps filter by check size).",
        },
        location: {
          type: "string",
          description: "Company location (e.g. 'Sydney, Australia'). Helps prioritize geographically relevant investors.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Number of matches to return (1-10). Default: 5.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "nuvc_screen_fund",
    description:
      "Screen a VC or PE fund the way a family office / LP allocator does — through NUVC's " +
      "LP-grade fund engine. Returns a 6-dimension screen (GP team quality, deal flow access, " +
      "track record, fund terms, fund status & timing, LP network), a one-sentence conviction " +
      "verdict, a Pass/Watch/proceed decision, confidence, strengths, and red flags. " +
      "Optionally pass your LP mandate (sectors, stages, geography, thesis) to shape thesis-fit. " +
      "This is the same engine behind the NUVC Family Office product — it cannot be replicated " +
      "locally. Use it to triage a fund before committing diligence time.",
    inputSchema: {
      type: "object",
      properties: {
        fund_name: { type: "string", minLength: 2, description: "Fund name (e.g. 'Blackbird Ventures Fund IV')" },
        gp_name: { type: "string", description: "GP / firm name" },
        strategy: { type: "string", description: "Fund strategy (e.g. 'Early-stage venture', 'Growth buyout')" },
        vintage_year: { type: "integer", minimum: 1980, maximum: 2035, description: "Vintage year (1980 to 2035)" },
        sector_focus: { type: "string", description: "Sector focus (e.g. 'B2B SaaS, deep tech')" },
        geography: { type: "string", description: "Geographic focus (e.g. 'ANZ', 'US')" },
        fund_size: { type: "number", description: "Fund size in USD" },
        track_record: { type: "string", maxLength: 5000, description: "Prior fund performance / GP track record narrative (up to 5,000 characters)" },
        description: { type: "string", maxLength: 20000, description: "Free-text description of the fund and GP (up to 20,000 characters)" },
        net_irr: { type: "number", description: "Net IRR (%) of prior fund(s)" },
        tvpi: { type: "number", description: "TVPI multiple" },
        dpi: { type: "number", description: "DPI multiple" },
        mandate: {
          type: "object",
          description: "Optional LP mandate to assess thesis fit against.",
          properties: {
            sectors: { type: "array", items: { type: "string" }, description: "Target sectors" },
            stages: { type: "array", items: { type: "string" }, description: "Target stages" },
            geography: { type: "string", description: "Target geography" },
            thesis: { type: "string", description: "Your LP investment thesis" },
          },
        },
      },
      required: ["fund_name"],
    },
  },
  {
    name: "nuvc_venture_math",
    description:
      "Compute venture finance metrics from raw startup financials — burn multiple, LTV/CAC ratio, " +
      "Rule of 40, default alive status, dilution, ARR multiples, and financial health score. " +
      "Optionally benchmark against stage-appropriate VC thresholds (elite/strong/adequate/concerning). " +
      "Pure math, no AI calls, instant response. Used to sanity-check a deal's metrics against stage benchmarks.",
    inputSchema: {
      type: "object",
      properties: {
        arr: { type: "number", description: "Annual recurring revenue (USD)" },
        mrr: { type: "number", description: "Monthly recurring revenue (USD)" },
        burn_rate: { type: "number", description: "Monthly burn rate (USD)" },
        runway_months: { type: "number", description: "Months of runway remaining" },
        cac: { type: "number", description: "Customer acquisition cost (USD)" },
        ltv: { type: "number", description: "Customer lifetime value (USD)" },
        gross_margin: { type: "number", description: "Gross margin percentage (0-100)" },
        total_raised: { type: "number", description: "Total capital raised to date (USD)" },
        raise_amount: { type: "number", description: "Current round size (USD)" },
        pre_money_valuation: { type: "number", description: "Pre-money valuation (USD)" },
        revenue_growth_rate: { type: "number", description: "Revenue growth rate (%)" },
        stage: {
          type: "string",
          enum: ["pre_seed", "seed", "series_a", "series_b", "series_c", "growth"],
          description: "Funding stage (default: seed). Used for benchmark comparison.",
        },
        benchmark: {
          type: "boolean",
          description: "If true, also compare metrics against stage-appropriate VC benchmarks. Default: true.",
        },
      },
    },
  },
  {
    name: "nuvc_fund_economics",
    description:
      "Compute fund economics from an LP perspective — fee drag, GP alignment score, J-curve position, " +
      "return decomposition (alpha vs beta), concentration risk, and overall fund health score. " +
      "Also computes portfolio construction math: investable capital, implied portfolio count, " +
      "follow-on reserves, and deployment capacity. Pure math, instant response. " +
      "For VCs sizing their fund, or LPs/family offices evaluating VC/PE fund commitments.",
    inputSchema: {
      type: "object",
      properties: {
        fund_size: { type: "number", description: "Total fund size (USD)" },
        management_fee: { type: "number", description: "Annual management fee rate (%, e.g. 2.0)" },
        carry: { type: "number", description: "Carried interest rate (%, e.g. 20)" },
        preferred_return: { type: "number", description: "Preferred return / hurdle rate (%)" },
        tvpi: { type: "number", description: "Total Value to Paid-In multiple" },
        dpi: { type: "number", description: "Distributions to Paid-In multiple" },
        net_irr: { type: "number", description: "Net IRR (%)" },
        vintage_year: { type: "integer", description: "Fund vintage year" },
        portfolio_count: { type: "integer", description: "Number of portfolio companies" },
        fund_life_years: { type: "integer", description: "Fund life in years" },
        avg_check_size: { type: "number", description: "Average initial check size (USD)" },
        reserve_ratio: { type: "number", description: "Follow-on reserve ratio (0-1, default 0.50)" },
        include_portfolio: {
          type: "boolean",
          description: "If true, also compute portfolio construction math. Default: true.",
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** House confidence bands: High 0.8-1.0, Medium 0.5-0.8, Low 0.2-0.5, Uncertain below 0.2. */
function confidenceText(c) {
  const n = Number(c);
  if (c === null || c === undefined || c === "" || !Number.isFinite(n)) return typeof c === "string" && c ? cleanText(c) : null;
  const band = n >= 0.8 ? "High" : n >= 0.5 ? "Medium" : n >= 0.2 ? "Low" : "Uncertain";
  return `${band} (${n.toFixed(2)})`;
}

async function handleScore(ctx, args = {}) {
  const { text } = args;
  const body = { text };
  // Mandate is firm-account state: send only an explicit per-call override. With none, the API
  // resolves the mandate stored on the account that owns the key (no client-side session state).
  const mandate = buildMandate(args.mandate || {});
  if (mandate) body.mandate = mandate;
  for (const k of ["stage", "industry", "geography", "raise_amount"]) {
    if (args[k] != null) body[k] = args[k];
  }
  const res = await ctx.apiCall("POST", "/ai/score", body);
  const data = unwrap(res);
  // Flat contract first, legacy nested `scores` alias as fallback.
  const scores = field(data, "scores") || {};
  const overall = field(data, "overall_score") ?? field(scores, "overall_score");
  const dimensions = field(scores, "scores") || field(data, "criteria_scores") || {};
  const summary = field(scores, "summary") || field(data, "summary") || "";

  const lines = ["## NUVC VCGrade Score\n"];
  if (overall !== undefined) {
    const n = Number(overall);
    const emoji = n >= 7 ? "🟢" : n >= 5 ? "🟡" : "🔴";
    const verdict =
      n >= 8 ? "Exceptional — investors will lean in"
      : n >= 7 ? "Strong — worth pursuing seriously"
      : n >= 5 ? "Promising but needs work"
      : n >= 3 ? "Significant gaps to address"
      : "Back to the drawing board";
    lines.push(`${emoji} **Overall: ${n} / 10** — ${verdict}`);
    const conf = confidenceText(field(data, "confidence"));
    lines.push(conf ? `Confidence: ${conf}\n` : "");
  }
  const entries = Object.entries(dimensions).filter(
    ([k]) => !["overall_score", "summary", "raw"].includes(snake(k))
  );
  if (entries.length > 0) {
    lines.push("| Dimension | Score | Rationale |");
    lines.push("|-----------|-------|-----------|");
    for (const [key, val] of entries) {
      if (typeof val === "object" && val !== null) {
        lines.push(`| ${label(key)} | ${val.score ?? "—"}/10 | ${val.rationale ?? ""} |`);
      } else {
        lines.push(`| ${label(key)} | ${val}/10 | |`);
      }
    }
    lines.push("");
  }
  if (summary) lines.push(`**Summary:** ${summary}`);

  // Two-way mandate fit (present when a mandate was set/passed)
  const fit = field(data, "fit");
  if (fit) {
    lines.push("");
    lines.push("---");
    lines.push("## Mandate Fit — two-way\n");
    const cs = field(fit, "conviction_score");
    const dec = (fit.decision || "").toUpperCase();
    const decEmoji = dec === "PROCEED" ? "🟢" : dec === "WATCH" ? "🟡" : "🔴";
    // The API reports conviction on a 0-100 scale; the public screening display is always 0-10.
    if (typeof cs === "number" && Number.isFinite(cs) && cs >= 0 && cs <= 100) {
      lines.push(`${decEmoji} **ConvictionScore: ${cs / 10} / 10** · Decision: **${dec}**`);
    }
    const mutualFit = field(fit, "mutual_fit");
    const mf = typeof mutualFit === "number" ? Math.round(mutualFit * 100) : null;
    if (mf !== null) lines.push(`**Mutual fit: ${mf}%** — ${field(fit, "mutual_fit_label") || ""}\n`);

    const a = field(fit, "fit_for_investor") || {};
    const aScore = typeof a.score === "number" ? Math.round(a.score * 100) : null;
    lines.push(`**→ Does it fit YOUR thesis?** ${aScore !== null ? aScore + "%" : "—"}`);
    for (const p of a.passes || []) lines.push(`- ✅ ${p}`);
    for (const f of a.fails || []) lines.push(`- ⚠️ ${f}`);

    const b = field(fit, "fit_for_founder") || {};
    const bScore = typeof b.score === "number" ? Math.round(b.score * 100) : null;
    lines.push(`\n**← Would the founder want YOU?** ${bScore !== null ? bScore + "%" : "—"}`);
    for (const r of b.reasons || []) lines.push(`- ${r}`);

    if (!body.stage && !body.industry && !body.geography && !body.raise_amount) {
      lines.push(`\n_Tip: pass stage, industry, geography, and raise_amount for a sharper fit._`);
    }
  }

  lines.push("\nNext: identify the evidence you need to resolve the key gaps before deciding whether to proceed. You retain the investment decision; another score or a co-investor search is optional and requires your request.");
  return lines.join("\n");
}

async function handleAnalyze(ctx, { text, analysis_type = "market" }) {
  const res = await ctx.apiCall("POST", "/ai/analyze", { text, analysis_type });
  const data = unwrap(res);
  return `## NUVC ${label(analysis_type)} Analysis\n\n${data.analysis || JSON.stringify(data, null, 2)}`;
}

/** A scalar as text; a list of scalars comma-joined; any nested object or list as bounded compact JSON. */
function valueText(v) {
  if (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object")) return v.join(", ");
  if (v !== null && typeof v === "object") return textOf(v);
  return String(v);
}

async function handleExtract(ctx, { text, extraction_type = "company" }) {
  const res = await ctx.apiCall("POST", "/ai/extract", { text, extraction_type });
  const data = unwrap(res);
  const extracted = data.extracted || data;
  if (typeof extracted !== "object" || extracted === null) return String(extracted);
  const lines = ["## NUVC Structured Extraction\n"];
  for (const [key, val] of Object.entries(extracted)) {
    if (val === null || val === undefined) continue;
    lines.push(`**${label(key)}:** ${valueText(val)}`);
  }
  return lines.join("\n");
}

async function handleModels(ctx) {
  const res = await ctx.apiCall("GET", "/ai/models");
  const data = unwrap(res);
  const lines = ["## NUVC Available Models\n"];
  if (Array.isArray(data.providers) && data.providers.length > 0) {
    lines.push("| Provider | Available | Healthy |");
    lines.push("|----------|-----------|---------|");
    for (const p of data.providers) {
      lines.push(`| ${p.name} | ${p.available ? "✓" : "✗"} | ${p.healthy ? "✓" : "✗"} |`);
    }
    lines.push("");
  }
  const embeddingModels = field(data, "embedding_models");
  if (Array.isArray(embeddingModels)) {
    lines.push(`**Embedding models:** ${embeddingModels.join(", ")}`);
  }
  if (data.preference) {
    lines.push(`**Preference:** ${Array.isArray(data.preference) ? data.preference.join(" → ") : data.preference}`);
  }
  return lines.join("\n");
}

async function handleMatchInvestors(ctx, args) {
  const { text, industry = "Technology", stage = "seed", raise_amount, location, limit = 5 } = args;
  const body = { text, industry, stage, limit };
  if (raise_amount) body.raise_amount = raise_amount;
  if (location) body.location = location;

  const res = await ctx.apiCall("POST", "/ai/match", body);
  const data = unwrap(res);
  const matches = data.matches || [];

  if (matches.length === 0) {
    return "## NUVC Investor Matching\n\nNo matching investors found for this profile. Review the deal’s sector, stage, geography and raise before deciding whether to request another nuvc_match_investors search. Another search uses a credit; do not retry automatically.";
  }

  // No pool-size claim: a count of the database is a public claim, so it is never printed.
  const lines = [
    `## NUVC Investor Matching\n`,
    `**${matches.length} ${matches.length === 1 ? "investor" : "investors"}** matched from the NUVC investor database | ` +
      `${field(data, "matching_method") === "semantic_embedding" ? "AI semantic matching" : "keyword matching"} | ` +
      `${field(data, "latency_ms") || "—"}ms\n`,
  ];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const f = (key) => field(m, key);
    const rawScore = f("match_score");
    const score = typeof rawScore === "number" ? (rawScore * 100).toFixed(0) : "—";
    const quality =
      f("match_quality") === "excellent" ? "🟣"
      : f("match_quality") === "strong" ? "🟢"
      : f("match_quality") === "moderate" ? "🟡"
      : "⚪";

    lines.push(`### ${i + 1}. ${f("investor_name")}${f("firm_name") ? ` — ${f("firm_name")}` : ""}`);
    lines.push(`${quality} **${score}% match** (${f("match_quality")})`);

    const details = [];
    if (f("investor_tier_label")) details.push(`**Tier:** ${f("investor_tier_label")}`);
    if (f("lead_investor_badge")) details.push(`**Role:** ${f("lead_investor_badge")}`);
    if (f("check_size_display")) details.push(`**Check:** ${f("check_size_display")}`);
    if (f("location")) details.push(`**Location:** ${f("location")}`);
    if (f("geographic_focus")) details.push(`**Geo focus:** ${f("geographic_focus")}`);
    if (details.length > 0) lines.push(details.join(" | "));

    const industries = f("industries");
    if (industries && industries.length > 0) lines.push(`**Focus:** ${industries.join(", ")}`);
    const stages = f("funding_stages");
    if (stages && stages.length > 0) lines.push(`**Stages:** ${stages.join(", ")}`);
    if (f("thesis_snippet")) lines.push(`**Thesis:** ${f("thesis_snippet")}`);
    const tags = f("value_add_tags");
    if (tags && tags.length > 0) lines.push(`**Value-add:** ${tags.join(", ")}`);
    if (f("reasoning")) lines.push(`*${f("reasoning")}*`);
    if (f("website")) lines.push(`**Website:** ${f("website")}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("Next: verify the shortlist against each investor’s current thesis and cheque size before choosing whom to approach. A match does not imply interest or an introduction.");

  return lines.join("\n");
}

async function handleScreenFund(ctx, args) {
  const res = await ctx.apiCall("POST", "/ai/screen-fund", args);
  const data = unwrap(res);

  const lines = [`## NUVC Fund Screen — ${field(data, "fund_name") || args.fund_name}\n`];

  const score = field(data, "screening_score");
  if (score !== null && score !== undefined) {
    const n = Number(score);
    const emoji = n >= 7 ? "🟢" : n >= 5 ? "🟡" : "🔴";
    lines.push(`${emoji} **Screen: ${n.toFixed(1)} / 10**` + (data.confidence ? ` · ${data.confidence} confidence` : "") + "\n");
  }
  if (data.decision) {
    const decisionReason = field(data, "decision_reason");
    lines.push(`**Decision:** ${data.decision}` + (decisionReason ? ` — ${decisionReason}` : "") + "\n");
  }
  if (data.verdict) lines.push(`> ${data.verdict}\n`);

  if ((score === null || score === undefined) && !data.decision && !data.verdict) {
    lines.push("No result was returned for this fund; try again.");
    return lines.join("\n");
  }

  const dims = data.dimensions || {};
  const dimEntries = Object.entries(dims).filter(([, v]) => v !== null && v !== undefined);
  if (dimEntries.length > 0) {
    lines.push("| LP Dimension | Score |");
    lines.push("|--------------|-------|");
    for (const [key, val] of dimEntries) {
      const v = typeof val === "object" && val !== null ? (val.score ?? "—") : val;
      lines.push(`| ${label(key)} | ${v}/10 |`);
    }
    lines.push("");
  }

  if (Array.isArray(data.strengths) && data.strengths.length > 0) {
    lines.push("**Strengths:**");
    for (const s of data.strengths) lines.push(`- ✅ ${s}`);
    lines.push("");
  }
  const redFlags = field(data, "red_flags");
  if (Array.isArray(redFlags) && redFlags.length > 0) {
    lines.push("**Red flags:**");
    for (const r of redFlags) lines.push(`- ⚠️ ${r}`);
    lines.push("");
  }
  if (field(data, "insufficient_data")) {
    lines.push("_Note: limited data provided — confidence is capped. Add track record, vintage, and metrics for a sharper screen._");
  }

  lines.push("---");
  lines.push("Next: request evidence for the red flags and missing track record before deciding whether to proceed with diligence. To examine the terms separately, you can request nuvc_fund_economics with the fund’s fee and carry details. You retain the allocation decision.");

  return lines.join("\n");
}

async function handleVentureMath(ctx, args) {
  const { benchmark = true, ...financials } = args;
  // A stage alone is not a figure: with no number supplied there is nothing to compute or score.
  const supplied = Object.entries(financials).some(([k, v]) => k !== "stage" && typeof v === "number" && Number.isFinite(v));
  if (!supplied) {
    return "## NUVC Venture Math\n\nNo figures were supplied, so there is nothing to compute. Pass at least one of: arr, mrr, burn_rate, runway_months, cac, ltv, gross_margin, total_raised, raise_amount, pre_money_valuation, revenue_growth_rate.";
  }
  const res = await ctx.apiCall("POST", "/ai/venture-math/compute", financials);
  const metrics = unwrap(res);

  const lines = ["## NUVC Venture Math\n"];

  // Format computed metrics
  const fmt = (v) => (v === null || v === undefined ? "—" : typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(2)) : v);
  const metricLabels = {
    burn_multiple: "Burn Multiple",
    ltv_cac_ratio: "LTV/CAC Ratio",
    rule_of_40: "Rule of 40",
    default_alive: "Default Alive",
    arr_multiple: "ARR Multiple",
    dilution_pct: "Dilution %",
    runway_months: "Runway (months)",
    gross_margin: "Gross Margin %",
    financial_health_score: "Financial Health Score",
  };

  const entries = Object.entries(metrics).filter(([k]) => snake(k) in metricLabels);
  if (entries.length > 0) {
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    for (const [key, val] of entries) {
      lines.push(`| ${metricLabels[snake(key)]} | ${fmt(val)} |`);
    }
    lines.push("");
  }

  // Benchmark comparison
  if (benchmark) {
    try {
      const stage = financials.stage || "seed";
      const benchRes = await ctx.apiCall("POST", "/ai/venture-math/benchmark", { metrics: snakeKeys(metrics), stage });
      const benchmarks = unwrap(benchRes);
      if (benchmarks && typeof benchmarks === "object") {
        const benchEntries = Object.entries(benchmarks).filter(
          ([, v]) => typeof v === "object" && v !== null && v.signal
        );
        if (benchEntries.length > 0) {
          lines.push(`### Benchmark vs ${stage.replace(/_/g, " ").toUpperCase()} stage\n`);
          lines.push("| Metric | Value | Signal | Benchmark |");
          lines.push("|--------|-------|--------|-----------|");
          for (const [key, b] of benchEntries) {
            const metricLabel = metricLabels[snake(key)] || label(key);
            const signal =
              b.signal === "elite" ? "🟣 Elite"
              : b.signal === "strong" ? "🟢 Strong"
              : b.signal === "adequate" ? "🟡 Adequate"
              : b.signal === "concerning" ? "🔴 Concerning"
              : "⚪ No data";
            const bar = ["great", "good", "concern"].filter((k) => b[k] !== undefined).map((k) => `${k} ${b[k]}`).join(" / ");
            lines.push(`| ${metricLabel} | ${b.value === null || b.value === undefined ? "—" : fmt(b.value)} | ${signal} | ${bar} |`);
          }
          lines.push("");
        }
      }
    } catch (err) {
      // Benchmark is optional — don't fail the whole tool, but say why the section is missing.
      lines.push(`_Benchmark comparison skipped: ${cleanText(err?.message) || "request failed"}_`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

async function handleFundEconomics(ctx, args) {
  const { include_portfolio = true, avg_check_size, reserve_ratio, ...fundParams } = args;

  const res = await ctx.apiCall("POST", "/ai/venture-math/fund-economics", fundParams);
  const data = unwrap(res);

  const lines = ["## NUVC Fund Economics\n"];
  const fmt = (v) => (typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(2)) : v);

  // Key economics — the API nests these (fee_economics, gp_alignment, jcurve_position, concentration);
  // the pre-1.4.2 client read flat names that never existed (fee_drag, gp_alignment_score, ...) and so
  // rendered only the health score. [section, key, label]
  const fe = field(data, "fee_economics") || {};
  const gp = field(data, "gp_alignment") || {};
  const jc = field(data, "jcurve_position") || {};
  const cc = field(data, "concentration") || {};
  // The calculator fills in 2% / 20% only when the caller gave nothing (null or undefined); an explicit 0
  // is a disclosed term and is honoured. Prefer the server's own `fee_economics.terms_assumed`; for an older
  // server that does not send it, fall back to whether the input was left out.
  const unset = (v) => v === null || v === undefined;
  const serverAssumed = field(fe, "terms_assumed");
  const feeAssumed = Array.isArray(serverAssumed) ? serverAssumed.includes("management_fee") : unset(fundParams.management_fee);
  const carryAssumed = Array.isArray(serverAssumed) ? serverAssumed.includes("carry") : unset(fundParams.carry);
  const assumed = [feeAssumed ? "2% management fee" : null, carryAssumed ? "20% carry" : null].filter(Boolean);
  const assumedNote = assumed.length ? ` (assumed ${assumed.join(" and ")})` : "";
  const economicRows = [
    ["Fund Health Score", field(data, "fund_health_score")],
    [`Fee Drag %${assumedNote}`, field(fe, "fee_drag_pct")],
    ["Total Lifetime Fees (USD)", field(fe, "total_lifetime_fees")],
    ["Investable Capital (USD)", field(fe, "investable_capital")],
    ["GP Carry % of GP Economics", field(gp, "carry_pct_of_total")],
    ["GP Aligned", field(gp, "aligned")],
    ["J-Curve Position", field(jc, "performance_vs_peers")],
    ["Fund Age (years)", field(jc, "fund_age_years")],
    ["Concentration", field(cc, "concentration_label")],
  ].filter(([, v]) => v !== undefined && v !== null);
  if (economicRows.length > 0) {
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    for (const [name, v] of economicRows) {
      lines.push(`| ${name} | ${typeof v === "string" ? label(v) : fmt(v)} |`);
    }
    lines.push("");
  }

  // Return decomposition
  const rd = field(data, "return_decomposition");
  if (rd) {
    lines.push("### Return Decomposition\n");
    for (const [key, val] of Object.entries(rd)) {
      lines.push(`**${label(key)}:** ${fmt(val)}`);
    }
    lines.push("");
  }

  // Full data fallback for any extra fields
  const shown = new Set(["fund_health_score", "return_decomposition"]);
  const extra = Object.entries(data).filter(
    ([k, v]) => !shown.has(snake(k)) && v !== null && v !== undefined && typeof v !== "object"
  );
  if (extra.length > 0) {
    for (const [key, val] of extra) {
      lines.push(`**${label(key)}:** ${fmt(val)}`);
    }
    lines.push("");
  }

  const signals = field(data, "signals");
  if (Array.isArray(signals) && signals.length > 0) {
    lines.push("### Signals\n");
    for (const sig of signals) lines.push(`- ${sig}`);
    lines.push("");
  }

  // Portfolio construction (optional second call)
  if (include_portfolio && (args.fund_size || fundParams.fund_size)) {
    try {
      const portfolioReq = {
        fund_size: args.fund_size || fundParams.fund_size,
        avg_check_size: avg_check_size || undefined,
        reserve_ratio: reserve_ratio ?? 0.50,
        management_fee_rate: feeAssumed || unset(fundParams.management_fee) ? 0.02 : fundParams.management_fee / 100,
        fund_life_years: fundParams.fund_life_years || 10,
        investment_period_years: Math.min(fundParams.fund_life_years || 10, 5),
      };
      const pRes = await ctx.apiCall("POST", "/ai/venture-math/portfolio", portfolioReq);
      const pData = unwrap(pRes);

      lines.push("### Portfolio Construction\n");
      const portfolioFields = [
        ["investable_capital", "Investable Capital"],
        ["implied_portfolio_count", "Implied Portfolio Count"],
        ["follow_on_reserve", "Follow-On Reserve"],
        ["fee_drag_pct", "Fee Drag %"],
        ["total_deployment_capacity", "Total Deployment Capacity"],
      ];
      const pEntries = portfolioFields.filter(([k]) => field(pData, k) !== undefined);
      if (pEntries.length > 0) {
        lines.push("| Metric | Value |");
        lines.push("|--------|-------|");
        for (const [key, label] of pEntries) {
          const val = field(pData, key);
          const name = key === "fee_drag_pct" && feeAssumed ? `${label} (assumed 2% management fee)` : label;
          lines.push(`| ${name} | ${typeof val === "number" && val > 1000 ? `$${val.toLocaleString()}` : fmt(val)} |`);
        }
        lines.push("");
      }

      // Fallback for extra portfolio fields
      const pShown = new Set(portfolioFields.map(([k]) => k));
      const pExtra = Object.entries(pData).filter(
        ([k, v]) => !pShown.has(snake(k)) && v !== null && v !== undefined && typeof v !== "object"
      );
      for (const [key, val] of pExtra) {
        lines.push(`**${label(key)}:** ${typeof val === "number" && val > 1000 ? `$${val.toLocaleString()}` : fmt(val)}`);
      }
    } catch (err) {
      // Portfolio construction is optional — but say why the section is missing.
      lines.push(`_Portfolio section skipped: ${cleanText(err?.message) || "request failed"}_`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

function renderMandate(rawMandate) {
  const m = snakeKeys(rawMandate || {});
  const lines = [];
  if (m.sectors) lines.push(`**Sectors:** ${m.sectors.join(", ")}`);
  if (m.stages) lines.push(`**Stages:** ${m.stages.join(", ")}`);
  if (m.geography) lines.push(`**Geography:** ${m.geography}`);
  if (m.check_size_min != null || m.check_size_max != null) {
    const lo = m.check_size_min != null ? `$${Number(m.check_size_min).toLocaleString()}` : "—";
    const hi = m.check_size_max != null ? `$${Number(m.check_size_max).toLocaleString()}` : "—";
    lines.push(`**Cheque size:** ${lo} – ${hi}`);
  }
  if (m.thesis) lines.push(`**Thesis:** ${m.thesis}`);
  if (m.anti_thesis) lines.push(`**Anti-thesis:** ${m.anti_thesis}`);
  return lines.join("\n");
}

async function handleSetMandate(ctx, args) {
  const m = buildMandate(args || {});
  if (!m) {
    return "No mandate fields provided. Pass at least one of: sectors, stages, geography, check_size_min/max, thesis, anti_thesis.";
  }
  // The mandate is bound to the firm account that owns the API key. There is no session-only
  // fallback: if it cannot be saved to the account we say so rather than pretend it is active.
  const res = await ctx.apiCall("POST", "/ai/mandate", m);
  const data = unwrap(res);
  if (field(data, "persisted") !== true) {
    throw new Error(
      "The mandate could not be saved to your firm account right now, so it was NOT applied. Retry shortly, " +
        "or pass `mandate` directly to nuvc_score for a one-off fit."
    );
  }
  return [
    "## Mandate saved ✓\n",
    "Saved to your firm account — every `nuvc_score` made with this account's keys (here, REST, or web) now returns a two-way mandate↔deck fit.\n",
    renderMandate(m),
  ].join("\n");
}

async function handleGetMandate(ctx) {
  const res = await ctx.apiCall("GET", "/ai/mandate");
  const data = unwrap(res);
  const m = data?.mandate ? buildMandate(data.mandate) : null;
  if (!m) {
    return "No mandate saved on this firm account. Use `nuvc_set_mandate` to save one, then score decks to get a two-way fit verdict.";
  }
  return ["## Firm mandate\n", renderMandate(m)].join("\n");
}

/** The default (investor) surface: scoring/screening tools plus the read-only workspace tools. */
// Annotations follow the HTTP method each handler uses and whether its route is metered:
//  - GET and unmetered -> readOnlyHint true (a client may auto-approve it).
//  - POST to a metered route (spends paid credits or quota) -> not read-only.
//  - POST to the unmetered venture-math routes (pure computation, nothing stored) -> not read-only (it is a POST),
//    idempotent.
const READ = { readOnlyHint: true, openWorldHint: false };
const METERED = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const COMPUTE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const TOOL_ANNOTATIONS = {
  nuvc_billing: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  nuvc_score: METERED, // POST /ai/score, consumes a score credit
  nuvc_analyze: METERED, // POST /ai/analyze, counts against the monthly quota
  nuvc_extract: METERED, // POST /ai/extract, counts against the monthly quota
  nuvc_match_investors: METERED, // POST /ai/match, metered
  nuvc_screen_fund: METERED, // POST /ai/screen-fund, metered
  nuvc_get_mandate: READ, // GET /ai/mandate
  nuvc_models: READ, // GET /ai/models
  nuvc_venture_math: COMPUTE, // POST /ai/venture-math/*, unmetered
  nuvc_fund_economics: COMPUTE, // POST /ai/venture-math/*, unmetered
  nuvc_my_deals: READ, // GET /vc/deal-library
  nuvc_deal_brief: READ, // GET /vc/deals/{id}/brief
  nuvc_precedent: READ, // GET /vc/deals/{id}/precedent
  // Overwrites the firm's saved mandate (same inputs -> same stored state).
  nuvc_set_mandate: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};

/** Tools whose result carries text derived from other parties' content, or stored text a prompt-injected set_mandate could have written; marked as data. */
const THIRD_PARTY_TEXT_TOOLS = ["nuvc_get_mandate", "nuvc_score", "nuvc_analyze", "nuvc_extract", "nuvc_match_investors", "nuvc_screen_fund"];

export const TOOLS = withAnnotations([...INVESTOR_TOOLS, ...WORKSPACE_TOOLS], TOOL_ANNOTATIONS);

/**
 * Build the tool handlers for ONE session/request. The credential lives in this closure — never at
 * module level — and the handlers hold NO mandate state: the mandate is stored on the firm account
 * that owns the key, so every key (and every client) of that account sees the same one.
 *
 * @param {string | (() => string | undefined)} apiKey  the caller's own key, or a getter
 *   (stdio mode passes `() => process.env.NUVC_API_KEY`).
 */
export function createHandlers(apiKey) {
  const ctx = { apiCall: createApiCall(apiKey) };
  const bind = (fn) => (args) => fn(ctx, args || {});
  const handlers = {
    nuvc_billing: async (args = {}) => {
      assertNoForeignIdentityArgs(args);
      return readBilling(ctx.apiCall, "/ai/billing", new Set(TOOLS.map((t) => t.name)));
    },
    nuvc_score: bind(handleScore),
    nuvc_set_mandate: bind(handleSetMandate),
    nuvc_get_mandate: bind(handleGetMandate),
    nuvc_analyze: bind(handleAnalyze),
    nuvc_extract: bind(handleExtract),
    nuvc_models: bind(handleModels),
    nuvc_match_investors: bind(handleMatchInvestors),
    nuvc_screen_fund: bind(handleScreenFund),
    nuvc_venture_math: bind(handleVentureMath),
    nuvc_fund_economics: bind(handleFundEconomics),
    // Read-only investor-workspace tools: the key owner's own pipeline + decisions.
    ...createWorkspaceHandlers({ apiCall: ctx.apiCall, unwrap, snakeKeys }),
  };
  for (const name of THIRD_PARTY_TEXT_TOOLS) {
    const inner = handlers[name];
    handlers[name] = async (args) => withUntrustedNotice(await inner(args));
  }
  // Not advertised, but a pinned 1.x client calling it gets a migration message, not "Unknown tool".
  handlers.nuvc_roast = async () => {
    throw new Error(
      "nuvc_roast was removed from nuvc-mcp 2.0, which is investor-only. Use repyh-mcp for founder workflows; " +
        "nuvc-mcp@1.4.1 retains legacy behavior."
    );
  };
  return handlers;
}

/** Tools advertised on tools/list: the investor surface only. */
export function getTools() {
  return TOOLS;
}
