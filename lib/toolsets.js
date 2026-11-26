/**
 * Toolsets: which tools an assistant is shown, and how each is worded, for how you invest.
 *
 * Only three things change with the toolset: which tools are advertised, their order, and their
 * description (with one example prompt at the end). Tool names, input schemas and annotations never
 * change, and a tool outside the active toolset can still be called by name.
 *
 * `auto` reads ONE field (the account's investor type) from the caller's own profile, once, and maps it
 * to a toolset. Any failure (no profile, a key that may not call that route, a timeout, a malformed body)
 * resolves to `all`: a failed lookup never hides a tool and never breaks tools/list.
 */

export const TOOLSET_NAMES = ["angel", "vc", "allocator", "integrator", "all"];
export const AUTO = "auto";
export const ACCEPTED_TOOLSETS = [...TOOLSET_NAMES, AUTO];

/** What a connection uses when NUVC_TOOLSET is unset or not recognised. One line to change. */
export const DEFAULT_TOOLSET = AUTO;

/** The account's investor type -> toolset. Anything not listed (or missing) resolves to `all`. */
const INVESTOR_TYPE_TOOLSET = {
  angel: "angel",
  angel_syndicate: "angel",
  syndicate: "angel",
  vc: "vc",
  venture_capital: "vc",
  corporate_vc: "vc",
  growth_equity: "vc",
  family_office: "allocator",
  fund_of_funds: "allocator",
};

export function toolsetForInvestorType(type) {
  if (typeof type !== "string") return "all";
  const key = type.trim().toLowerCase();
  return Object.hasOwn(INVESTOR_TYPE_TOOLSET, key) ? INVESTOR_TYPE_TOOLSET[key] : "all";
}

// ---------------------------------------------------------------------------
// Wording. [tool name, description, example prompt] in display order.
// ---------------------------------------------------------------------------

const MY_DEALS = ["nuvc_my_deals", "Your own deal pipeline: each company, its stage and its screening score out of 10. Read-only, your account only.", "List my pipeline by stage with the screening score on each deal."];
const DEAL_BRIEF = ["nuvc_deal_brief", "One deal's brief: score with confidence, signals for and against, open questions, and how you decided on similar deals. Read-only.", "Open the brief for Acme and list the questions I still need to ask."];
const PRECEDENT = ["nuvc_precedent", "How you decided on similar deals before: how many you passed, your usual reasons, the score each had. Needs 3 similar decisions.", "Have I passed on deals like this before, and why?"];
const VENTURE_MATH = ["nuvc_venture_math", "Check a startup's burn, runway, LTV/CAC and round dilution against stage benchmarks. Free.", "$40K MRR, $90K monthly burn, raising $1.5M seed at $8M pre. Do the numbers hold?"];
const SET_MANDATE = ["nuvc_set_mandate", "Save your mandate: sectors, stages, cheque size, thesis, what you avoid. Replaces the saved one, so send every field.", "Save my mandate: seed, B2B software, ANZ, $25K to $100K cheques, no hardware."];
const GET_MANDATE = ["nuvc_get_mandate", "Show the mandate your scores are checked against.", "What mandate do you have saved for me?"];

const ANGEL_SCORE = ["nuvc_score", "Score a pitch 0 to 10 across 5 areas, with a confidence level. If a mandate is saved, it is checked against it. 1 credit.", "Score this pitch against my saved mandate: [paste]"];
const ANGEL_MATCH = ["nuvc_match_investors", "Find co-investors and syndicate partners whose thesis fits this deal. 1 credit.", "Who else backs seed-stage climate software in Australia and could join this syndicate?"];

const VC_SCORE = ["nuvc_score", "Score an inbound pitch 0 to 10 across 5 areas, with a confidence level, and check it against your fund's saved mandate. 1 credit.", "Screen this deck against our mandate: [paste]"];
const VC_MATCH = ["nuvc_match_investors", "Find co-investors and follow-on partners whose thesis fits this deal. 1 credit.", "Who could co-lead a $3M seed in vertical SaaS in ANZ?"];
const VC_EXTRACT = ["nuvc_extract", "Pull revenue, growth, team size and stage out of a deck or memo into fields. Uses your monthly quota.", "Extract the key metrics from this memo into a table: [paste]"];
const VC_FUND_ECON = ["nuvc_fund_economics", "Work out fee drag, reserves and how many companies a fund of your size can hold. Free.", "$30M Fund II, 2% fee, 20% carry, $500K average cheque. How many companies can we back?"];

// The screen line carries a confidence level and a one-line verdict; the handler prints both, so both are described.
const ALLOC_SCREEN = ["nuvc_screen_fund", "Screen a fund the way an LP does: a 0 to 10 screen across six areas with a confidence level, a one-line verdict, strengths and red flags, optionally against a mandate you pass. 1 credit.", "Screen Fund IV of [GP]: 2021 vintage, $120M, 2.1x TVPI, 0.6x DPI, against ANZ early-stage venture."];
const ALLOC_FUND_ECON = ["nuvc_fund_economics", "Fee drag, GP alignment, J-curve position and concentration risk for a fund you are weighing. Free.", "$80M fund, 2.5% fee, 25% carry, 8% hurdle, 2022 vintage. What does fee drag look like?"];
const ALLOC_SCORE = ["nuvc_score", "Score a direct deal 0 to 10 across 5 areas with a confidence level, checked against a mandate you pass in. 1 credit.", "Score this co-investment deck against growth fintech in Asia-Pacific, $2M to $5M: [paste]"];
const ALLOC_MATH = ["nuvc_venture_math", "Check a direct deal's numbers against stage benchmarks. Free.", "Do these metrics hold up for a Series A: [numbers]"];
const ALLOC_EXTRACT = ["nuvc_extract", "Pull the key figures out of a deck, memo or update letter into fields. Uses your monthly quota.", "Extract the key figures from this fund update: [paste]"];
const ALLOC_ANALYZE = ["nuvc_analyze", "Background on a market or manager from text you paste, for diligence. Uses your monthly quota.", "List the market risks in this fund memo: [paste]"];

// Integrators call the API from their own code or agent: neutral wording, and no workspace or mandate tools
// (pass a mandate inline to nuvc_score).
const INT_MODELS = ["nuvc_models", "Check whether the NUVC scoring service is available right now. Free.", "Is NUVC scoring available right now?"];
const INT_SCORE = ["nuvc_score", "Score a pitch 0 to 10 across 5 areas, with a confidence level. Pass a mandate inline to check fit against it. 1 credit.", "Score this pitch text and return the result as JSON I can show in my platform."];
const INT_EXTRACT = ["nuvc_extract", "Pull revenue, growth, team size and stage out of pitch text into fields. Uses your monthly quota.", "Extract the company fields from this pitch text: [paste]"];
const INT_ANALYZE = ["nuvc_analyze", "Analyse a market, competitors or financials from text you pass in: insights, opportunities and risks. Uses your monthly quota.", "Analyse the competitive landscape in this text: [paste]"];
const INT_MATCH = ["nuvc_match_investors", "Find investors whose thesis fits a startup description, ranked, with a reason for each. 1 credit.", "Find five seed-stage investors for this startup description: [paste]"];
const INT_SCREEN = ["nuvc_screen_fund", "Screen a fund: a 0 to 10 screen across six areas with a confidence level, a one-line verdict, strengths and red flags. 1 credit.", "Screen this fund from the details below: [paste]"];
const INT_MATH = ["nuvc_venture_math", "Check a startup's burn, runway, LTV/CAC and dilution against stage benchmarks. Free.", "Run venture math on these figures and show the benchmark signals: [numbers]"];
const INT_FUND_ECON = ["nuvc_fund_economics", "Work out a fund's fee drag, GP alignment, J-curve position and portfolio construction from its terms. Free.", "Work out fund economics for these terms: [numbers]"];

const BILLING = ["nuvc_billing", "Check your current balance, quota, tool costs and available pack price. Free read; no purchase.", "What will this cost and what is my balance?"];

const ANGEL = [BILLING, MY_DEALS, DEAL_BRIEF, PRECEDENT, ANGEL_SCORE, VENTURE_MATH, ANGEL_MATCH, SET_MANDATE, GET_MANDATE];
const VC = [BILLING, MY_DEALS, DEAL_BRIEF, PRECEDENT, VC_EXTRACT, VC_SCORE, VENTURE_MATH, VC_MATCH, SET_MANDATE, GET_MANDATE, VC_FUND_ECON];
const ALLOCATOR = [BILLING, ALLOC_SCREEN, ALLOC_FUND_ECON, ALLOC_SCORE, ALLOC_MATH, ALLOC_EXTRACT, ALLOC_ANALYZE];
const INTEGRATOR = [BILLING, INT_MODELS, INT_SCORE, INT_EXTRACT, INT_ANALYZE, INT_MATCH, INT_SCREEN, INT_MATH, INT_FUND_ECON];

const WORDED = { angel: ANGEL, vc: VC, allocator: ALLOCATOR, integrator: INTEGRATOR };

/** Description with its example prompt at the end (MCP has no separate field for an example). */
function worded([, description, example]) {
  return `${description} Example: "${example}"`;
}

/**
 * The advertised tools for a toolset, in its display order. `allTools` is the full list (names, input
 * schemas, annotations); only the description is replaced, so every other property is the same object
 * as in `all`. `all` returns the list unchanged.
 */
export function toolsFor(name, allTools) {
  const rows = WORDED[name];
  if (!rows) return allTools;
  const byName = new Map(allTools.map((t) => [t.name, t]));
  return rows.map((row) => {
    const tool = byName.get(row[0]);
    if (!tool) throw new Error(`toolset ${name} names an unknown tool`);
    return { ...tool, description: worded(row) };
  });
}

/** The tool names a toolset advertises (`all`: undefined, meaning every tool). */
export function toolNamesIn(name) {
  return WORDED[name]?.map((row) => row[0]);
}

/** True when `tool` is advertised by `toolset`. */
export function inToolset(toolset, tool) {
  const names = toolNamesIn(toolset);
  return names ? names.includes(tool) : true;
}

// ---------------------------------------------------------------------------
// Choosing the toolset
// ---------------------------------------------------------------------------

/** A requested name (case and spaces ignored) when it is one we accept, else undefined. */
export function parseToolset(raw) {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  return ACCEPTED_TOOLSETS.includes(v) ? v : undefined;
}

/**
 * The process-wide setting from NUVC_TOOLSET. Unset or empty -> the default, silently. A value that is not
 * recognised -> the default with one stderr warning (the value itself is not echoed).
 */
export function toolsetFromEnv(env = process.env, warn = (line) => console.error(line)) {
  const raw = env.NUVC_TOOLSET;
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_TOOLSET;
  const parsed = parseToolset(String(raw));
  if (parsed) return parsed;
  warn(`nuvc-mcp: NUVC_TOOLSET is not recognised, using the default (${DEFAULT_TOOLSET}). Use one of: ${ACCEPTED_TOOLSETS.join(", ")}.`);
  return DEFAULT_TOOLSET;
}

const PROFILE_PATH = "/vc/profiles"; // GET: the caller's own investor profile
export const LOOKUP_TIMEOUT_MS = 3000;

/**
 * The account's investor type, or null. Reads that ONE field from the response and passes nothing else on.
 * Any failure (no profile, refused, timeout, malformed body) is null.
 */
export async function lookupInvestorType(apiCall) {
  try {
    const res = await apiCall("GET", PROFILE_PATH, undefined, { timeoutMs: LOOKUP_TIMEOUT_MS });
    const data = res && typeof res === "object" ? res.data : null; // {success, data, message}; data is null with no profile
    const type = data && typeof data === "object" ? (data.investorType ?? data.investor_type) : null;
    return typeof type === "string" && type.trim() ? type : null;
  } catch {
    return null;
  }
}

/**
 * A bounded cache of resolved toolsets, keyed by an id that is never a credential (stdio: a constant;
 * HTTP: the SHA-256 of the key). Entries expire after `ttlMs`; when full, the least recently used goes.
 * `inflight` lets concurrent first requests for one id share a single lookup.
 */
export function createToolsetCache({ ttlMs = 10 * 60_000, maxEntries = 10_000, now = Date.now } = {}) {
  const entries = new Map(); // id -> { value, expires }; insertion order = least recently used first
  return {
    inflight: new Map(),
    get(id) {
      const e = entries.get(id);
      if (!e) return undefined;
      entries.delete(id);
      if (e.expires <= now()) return undefined;
      entries.set(id, e);
      return e.value;
    },
    set(id, value) {
      entries.delete(id);
      while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      entries.set(id, { value, expires: now() + ttlMs });
    },
    size: () => entries.size,
  };
}

const SOURCE_TEXT = {
  account: "from your account type",
  setting: "from NUVC_TOOLSET",
  fallback: "default: all tools; account type not available",
  untailored: "all tools; no tailored set for your account type",
};

/** The one stderr line printed when a toolset is resolved. Names no key and nothing from the profile. */
export function toolsetLogLine(name, source) {
  return `nuvc-mcp toolset: ${name} (${SOURCE_TEXT[source]})`;
}

/**
 * A selector for one connection. `setting` is the process-wide setting (a validated name, possibly `auto`);
 * `resolve(override)` takes an optional per-request name that wins over it. `apiCall` is the connection's own
 * authenticated caller; `cache` and `cacheId` say where an `auto` answer is remembered.
 *
 * `announceSetting`: also print the line for an explicit setting (stdio does, once per process; HTTP only
 * prints when it does a lookup, so a request is not a log line).
 */
export function createToolsetSelector({ setting = DEFAULT_TOOLSET, apiCall, cache, cacheId, log = (line) => console.error(line), announceSetting = false }) {
  let announced = false;
  return {
    async resolve(override) {
      const requested = override ?? setting;
      if (requested !== AUTO) {
        if (announceSetting && override === undefined && !announced) {
          announced = true;
          log(toolsetLogLine(requested, "setting"));
        }
        return requested;
      }
      const hit = cache.get(cacheId);
      if (hit) return hit.name;
      let pending = cache.inflight.get(cacheId);
      if (!pending) {
        pending = (async () => {
          const type = await lookupInvestorType(apiCall);
          const name = toolsetForInvestorType(type);
          const source = type === null ? "fallback" : name === "all" ? "untailored" : "account";
          cache.set(cacheId, { name });
          log(toolsetLogLine(name, source));
          return name;
        })().finally(() => cache.inflight.delete(cacheId));
        cache.inflight.set(cacheId, pending);
      }
      return pending;
    },
    /** The active toolset when it is already known, without a lookup (undefined while `auto` is unresolved). */
    peek(override) {
      const requested = override ?? setting;
      return requested !== AUTO ? requested : cache.get(cacheId)?.name;
    },
  };
}

/**
 * A tool called by name that is not in the active toolset still runs. One closing line says so and how to see
 * every tool. It goes after the result, not before: a result that carries other parties' text opens with a fixed
 * data-not-instructions line, and that line stays first.
 */
export function withOutOfSetNote(result, tool, active, how) {
  if (!active || inToolset(active, tool)) return result;
  return `${result}\n\nNote: ${tool} is not in your active toolset (${active}), so it is not listed, but it ran. ${how}`;
}
